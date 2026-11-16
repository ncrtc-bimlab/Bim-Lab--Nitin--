FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js battery.js workbook.js lorawan-import.js ./
COPY public ./public

EXPOSE 3000

CMD ["node", "server.js"]
