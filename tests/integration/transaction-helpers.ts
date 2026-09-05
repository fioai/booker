import type { QueryResult, QueryResultRow } from 'pg';
import type {
  PostgresDatabasePort,
  PostgresTransactionPort,
} from '../../packages/database-postgres/src/index.js';

export interface TransactionQuery {
  readonly text: string;
  readonly values: readonly unknown[] | undefined;
}

interface TransactionQueryHooks {
  readonly afterQueryStarted?: (query: TransactionQuery) => Promise<void> | void;
  readonly afterQuery?: (query: TransactionQuery) => Promise<void> | void;
}

export function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

export function wrapTransactionQueries(
  source: PostgresDatabasePort,
  hooks: TransactionQueryHooks,
): PostgresDatabasePort {
  return {
    dialect: source.dialect,
    schema: source.schema,
    query<Row extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: readonly unknown[],
    ): Promise<QueryResult<Row>> {
      return source.query<Row>(text, values);
    },
    withTransaction<T>(work: (transaction: PostgresTransactionPort) => Promise<T>): Promise<T> {
      return source.withTransaction((transaction) => {
        return work({
          async query<Row extends QueryResultRow = QueryResultRow>(
            text: string,
            values?: readonly unknown[],
          ): Promise<QueryResult<Row>> {
            const query = { text, values };
            const resultPromise = transaction.query<Row>(text, values);
            await hooks.afterQueryStarted?.(query);
            const result = await resultPromise;
            await hooks.afterQuery?.(query);
            return result;
          },
        });
      });
    },
    close(): Promise<void> {
      return source.close();
    },
  };
}
