FROM node:22.23.1-alpine@sha256:b74031e546d7f4faf561d797ac1b76beccac856a042815ca77db4fd047581605 AS build

WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

RUN corepack enable
RUN corepack install --global pnpm@10.12.1

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY tsconfig.base.json tsconfig.json tsconfig.tests.json ./
COPY eslint.config.mjs prettier.config.mjs vitest.config.ts ./

RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:22.23.1-alpine@sha256:b74031e546d7f4faf561d797ac1b76beccac856a042815ca77db4fd047581605 AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/apps /app/apps
COPY --from=build /app/packages /app/packages
COPY --from=build /app/scripts /app/scripts

USER node
EXPOSE 3000
ENTRYPOINT ["node", "scripts/run-api.mjs"]
