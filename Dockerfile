FROM node:20-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    CSV_PATH=/data/songs.csv

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public

RUN mkdir -p /data
VOLUME ["/data"]

USER node
EXPOSE 8080

CMD ["node", "server/index.js"]
