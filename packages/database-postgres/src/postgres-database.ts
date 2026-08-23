import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

export interface PostgresConfig {
  readonly connectionString: string;
  readonly schema?: string;
}

export interface PostgresTransactionPort {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}

export interface PostgresDatabasePort extends PostgresTransactionPort {
  readonly dialect: 'postgres';
  readonly schema: string;
  withTransaction<T>(work: (transaction: PostgresTransactionPort) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const DEFAULT_SCHEMA = 'public';
const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]*$/u;

function validateSchema(schema: string): string {
  if (!SCHEMA_PATTERN.test(schema)) {
    throw new TypeError('PostgreSQL schema must be a lowercase SQL identifier.');
  }

  return schema;
}

async function queryWithClient<Row extends QueryResultRow = QueryResultRow>(
  client: PoolClient,
  text: string,
  values?: readonly unknown[],
): Promise<QueryResult<Row>> {
  return client.query<Row>(text, values === undefined ? undefined : [...values]);
}

export function createPostgresDatabase(config: PostgresConfig): PostgresDatabasePort {
  if (config.connectionString.trim().length === 0) {
    throw new TypeError('PostgreSQL connectionString must not be empty.');
  }

  const schema = validateSchema(config.schema ?? DEFAULT_SCHEMA);
  const pool = new Pool({ connectionString: config.connectionString });

  return {
    dialect: 'postgres',
    schema,
    query<Row extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: readonly unknown[],
    ): Promise<QueryResult<Row>> {
      return pool.query<Row>(text, values === undefined ? undefined : [...values]);
    },
    async withTransaction<T>(
      work: (transaction: PostgresTransactionPort) => Promise<T>,
    ): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work({
          query<Row extends QueryResultRow = QueryResultRow>(
            text: string,
            values?: readonly unknown[],
          ): Promise<QueryResult<Row>> {
            return queryWithClient(client, text, values);
          },
        });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    close(): Promise<void> {
      return pool.end();
    },
  };
}
