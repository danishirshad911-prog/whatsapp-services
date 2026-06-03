FROM node:20-alpine
RUN apk add --no-cache python3 make g++ libc6-compat
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
RUN mkdir -p .wa-sessions
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s CMD wget -qO- http://localhost:3001/health || exit 1
CMD ["node", "src/index.js"]
