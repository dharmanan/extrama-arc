FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

COPY backend/package.json ./package.json
RUN npm install --omit=dev && npm cache clean --force

COPY backend/src ./src

EXPOSE 8080

CMD ["npm", "start"]
