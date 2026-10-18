# The web service: the app's static files, served by scripts/serve.mjs, which also proxies
# /rpc/* to PostgREST so the browser sees one origin. Built from the repository root:
#
#   docker build -f docker/web/Dockerfile .
#
# No build step and no dependencies, by the project's design (CLAUDE.md, "No bundler"):
# package.json lists none, so there is no `npm ci`, and the image is the source files as
# they are in the tree. The context is narrowed by .dockerignore, an allowlist.

# Node's current LTS line, which the host also runs (package.json requires >= 20).
FROM node:24-alpine

WORKDIR /app

# Exactly what the browser and the server need, one line per reason:
COPY package.json index.html ./
#   the application modules, the design tokens, and the vendored d3-force they import
COPY src/ ./src/
COPY _ds/ ./_ds/
COPY vendor/ ./vendor/
#   the fixture data source fetches ./tests/fixtures/ (src/data/fixtures.js)
COPY tests/fixtures/ ./tests/fixtures/
#   serve.mjs resolves its root as `..` from its own location, so keep the scripts/ level
COPY scripts/serve.mjs ./scripts/serve.mjs

# Files stay root-owned and read-only to the process; the server only reads them.
USER node

# Inside the compose network PostgREST is the `api` service. Override for any other setup.
ENV POSTGREST_URL=http://api:3000
EXPOSE 8000

# `wget` ships with alpine's busybox; `/` is a static file, so this checks this process
# only. The full path through api is scripts/docker-smoke.sh's job.
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8000/ || exit 1

CMD ["node", "scripts/serve.mjs", "8000"]
