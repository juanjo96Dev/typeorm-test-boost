import {
  Connection,
  DataSource,
  DataSourceOptions,
  EntityManager,
} from "typeorm";
import { SQLScript } from "./sql-script";

type Table = { name: string };
type DependencyTree = {
  table_name: string;
  level: number;
};

type ColumnsWithAutoIncrement = {
  column_name: string;
  column_default: string;
};

type Manager = {
  foreignKey: {
    disable: () => Promise<void>;
    enable: () => Promise<void>;
  };
  restoreOrder: () => Promise<void>;
};
type ColumnStat = { maxindex: string | null };
type DBType = DataSourceOptions["type"];
type IncrementDetail = { column: string; sequenceName: string; index: string };

const INDEX_OFFSET_CONFIG: Partial<Record<DBType, number>> = {
  postgres: 1,
  cockroachdb: 0,
};

export class Fastypest extends SQLScript {
  private manager: EntityManager;
  private tables: Set<string> = new Set();
  private tablesWithAutoIncrement: Map<string, IncrementDetail[]> = new Map();

  constructor(connection: DataSource | Connection) {
    super(connection.options.type);
    this.manager = connection.manager;
  }

  public async init(): Promise<void> {
    await this.manager.transaction(async (em: EntityManager) => {
      await this.detectTables(em);
      const tables = [...this.tables];
      await Promise.all([
        this.createTempTable(em, tables),
        this.detectTablesWithAutoIncrement(em, tables),
      ]);
    });
  }

  private async createTempTable(
    em: EntityManager,
    tables: string[]
  ): Promise<void> {
    await Promise.all(
      tables.map(async (tableName) => {
        await this.execQuery(em, "createTempTable", { tableName });
      })
    );
  }

  private async detectTablesWithAutoIncrement(
    em: EntityManager,
    tables: string[]
  ): Promise<void> {
    for (const tableName of tables) {
      await this.processTable(em, tableName);
    }
  }

  private async processTable(
    em: EntityManager,
    tableName: string
  ): Promise<void> {
    const columns = await this.getColumnsWithAutoIncrement(em, tableName);
    if (!columns) return;

    for (const column of columns) {
      await this.processColumn(em, tableName, column);
    }
  }

  private async getColumnsWithAutoIncrement(
    em: EntityManager,
    tableName: string
  ): Promise<ColumnsWithAutoIncrement[] | null> {
    const columns = await this.execQuery<ColumnsWithAutoIncrement>(
      em,
      "getColumnsWithAutoIncrement",
      { tableName }
    );
    return Array.isArray(columns) ? columns : null;
  }

  private async processColumn(
    em: EntityManager,
    tableName: string,
    column: ColumnsWithAutoIncrement
  ): Promise<void> {
    const stat = await this.getMaxColumnIndex(
      em,
      tableName,
      column.column_name
    );
    const sequenceName = this.getSequenceName(column.column_default);
    if (!sequenceName) return;

    const index = Number(stat?.maxindex) || 0;
    this.updateTablesWithAutoIncrement(tableName, {
      column: column.column_name,
      sequenceName,
      index: String(index + (INDEX_OFFSET_CONFIG[this.getType()] ?? 0)),
    });
  }

  private async getMaxColumnIndex(
    em: EntityManager,
    tableName: string,
    columnName: string
  ): Promise<ColumnStat | null> {
    const [stat] = await this.execQuery<ColumnStat>(em, "getMaxColumnIndex", {
      tableName,
      column_name: columnName,
    });
    return stat || null;
  }

  private getSequenceName(columnDefault: string): string | null {
    return columnDefault.match(/'([^']+)'/)?.[1] || null;
  }

  private updateTablesWithAutoIncrement(
    tableName: string,
    data: { column: string; sequenceName: string; index: string }
  ): void {
    if (!this.tablesWithAutoIncrement.has(tableName)) {
      this.tablesWithAutoIncrement.set(tableName, []);
    }

    this.tablesWithAutoIncrement.get(tableName)?.push(data);
  }

  public async restoreData(): Promise<void> {
    await this.manager.transaction(async (em: EntityManager) => {
      const { foreignKey, restoreOrder } = await this.restoreManager(em);
      await foreignKey.disable();
      await restoreOrder();
      await foreignKey.enable();
    });
  }

  protected async restoreManager(em: EntityManager): Promise<Manager> {
    if (this.tables.size === 0) {
      await this.detectTables(em);
    }

    const manager: Manager = {
      foreignKey: {
        disable: async () => Promise.resolve(),
        enable: async () => Promise.resolve(),
      },
      restoreOrder: async () => Promise.resolve(),
    };

    const typesWithForeignKey: DBType[] = ["postgres", "mariadb", "mysql"];
    if (typesWithForeignKey.includes(this.getType())) {
      manager.foreignKey.disable = async (): Promise<void> =>
        this.execQuery(em, "foreignKey.disable");
      manager.foreignKey.enable = async (): Promise<void> =>
        this.execQuery(em, "foreignKey.enable");
    }

    const { tables, sorted } = await this.getSortedDependencyTables(em);
    manager.restoreOrder = (): Promise<void> =>
      this.restoreOrder(em, tables, sorted ? "sorted" : "random");

    return manager;
  }

  private async getSortedDependencyTables(
    em: EntityManager
  ): Promise<{ tables: string[]; sorted: boolean }> {
    const dependencyTree = await this.execQuery<DependencyTree>(
      em,
      "dependencyTree"
    );

    if (!dependencyTree.length)
      return { tables: [...this.tables], sorted: false };

    const sortedTables = new Set(dependencyTree.map((row) => row.table_name));
    return { tables: [...sortedTables], sorted: true };
  }

  private async detectTables(em: EntityManager): Promise<void> {
    const tables = await this.execQuery<Table>(em, "getTables");

    tables.forEach((row) => {
      this.tables.add(row.name);
    });
  }

  private async restoreOrder(
    em: EntityManager,
    tables: string[],
    type: "sorted" | "random" = "random"
  ): Promise<void> {
    if (type === "sorted") {
      for (const tableName of tables) {
        await this.recreateData(em, tableName);
      }

      return;
    }

    await Promise.all(
      tables.map((tableName) => this.recreateData(em, tableName))
    );
  }

  private async recreateData(
    em: EntityManager,
    tableName: string
  ): Promise<void> {
    await this.execQuery(em, "truncateTable", { tableName });
    await this.execQuery(em, "restoreData", { tableName });
    await this.resetAutoIncrementColumns(em, tableName);
  }

  private async resetAutoIncrementColumns(
    em: EntityManager,
    tableName: string
  ): Promise<void> {
    const tables = this.tablesWithAutoIncrement.get(tableName);
    if (!tables) return;

    for (const { column, sequenceName, index } of tables) {
      await this.execQuery(em, "resetAutoIncrementColumn", {
        tableName,
        column,
        sequenceName,
        index,
      });
    }
  }
}
