FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY server.ts ./
COPY tsconfig.json ./

EXPOSE 3001

CMD ["node", "--import", "tsx/esm", "server.ts"]
