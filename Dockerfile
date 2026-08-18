# Two stages: build the warehouse, then ship a runtime that only carries the
# result.
#
# The warehouse is deliberately not in git. It is derived, and an 84MB binary
# has no place in a repository. But the app serves from it, so it has to exist
# in the image. Building it here from the committed landing zone keeps the repo
# clean, makes the image self-contained, and means the deployed site never calls
# Yahoo at request time.

# ---- stage 1: build the warehouse from the committed raw layer ----
FROM python:3.12-slim AS warehouse

WORKDIR /build

COPY pipeline/requirements.txt ./pipeline/requirements.txt
RUN pip install --no-cache-dir -r pipeline/requirements.txt

COPY warehouse ./warehouse

# profiles.yml points at ../warehouse/warehouse.duckdb relative to the dbt
# project, so running from /build/warehouse resolves correctly. `build` rather
# than `run`: if a data test fails, the image should not be produced.
WORKDIR /build/warehouse
RUN dbt build --profiles-dir .

# ---- stage 2: runtime ----
# Debian rather than Alpine: the DuckDB client is a native module and ships
# prebuilt binaries for glibc, so Alpine's musl would force a source build.
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY --from=warehouse /build/warehouse/warehouse.duckdb ./warehouse/warehouse.duckdb

# 127.0.0.1 is right on a laptop and unreachable from outside a container.
ENV HOST=0.0.0.0
ENV PORT=8080
EXPOSE 8080

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
