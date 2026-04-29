FROM node:18-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY . .

EXPOSE 7070

CMD ["node", "index.js"]
