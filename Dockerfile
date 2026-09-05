FROM node:22.23.1-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS build

WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

RUN corepack enable
RUN corepack install --global pnpm@10.12.1

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY tsconfig.base.json tsconfig.json tsconfig.tests.json ./

RUN pnpm install --frozen-lockfile
RUN pnpm build

# Reinstall from the build cache so the runtime store contains production dependencies only.
RUN rm -rf node_modules apps/*/node_modules packages/*/node_modules \
    && pnpm --filter @booking-engine/api... install --prod --frozen-lockfile --offline --ignore-scripts

# Keep compiled JavaScript, package manifests, migrations, and their dependency links.
RUN rm -rf packages/payments-stripe \
    && find apps packages -type f ! -path '*/node_modules/*' \
       ! -name package.json ! -name LICENSE ! -path '*/dist/*.js' ! -path '*/migrations/*.sql' -delete \
    && find apps packages -type d -empty -delete

FROM node:22.23.1-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY LICENSE /app/LICENSE
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/apps /app/apps
COPY --from=build /app/packages /app/packages
COPY scripts/run-api.mjs scripts/seed-sample.mjs scripts/migrate.mjs scripts/smoke-request-to-book.mjs /app/scripts/
COPY scripts/lib/environment.mjs scripts/lib/load-environment.mjs /app/scripts/lib/

USER node
EXPOSE 3000
ENTRYPOINT ["node", "scripts/run-api.mjs"]
