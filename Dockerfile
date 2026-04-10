FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY server.ts ./
COPY tsconfig.json ./
COPY privacy-policy.html ./

EXPOSE 3001

CMD ["node", "--import", "tsx/esm", "server.ts"]
