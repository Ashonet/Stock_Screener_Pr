# The app has no dependencies, so there is nothing to install and no build step.
FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public

# Bind to every interface: 127.0.0.1 is right on a laptop but unreachable
# from outside a container.
ENV HOST=0.0.0.0
ENV PORT=8080
EXPOSE 8080

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1

CMD ["node", "server.js"]
