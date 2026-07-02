FROM node:20-alpine

WORKDIR /app

# No third-party dependencies — pure Node stdlib.
COPY package.json ./
COPY server.js ./

ENV PORT=8080
EXPOSE 8080

USER node

CMD ["node", "server.js"]
