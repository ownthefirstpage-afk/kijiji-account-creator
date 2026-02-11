FROM mcr.microsoft.com/playwright:v1.41.0-jammy

WORKDIR /app
COPY package*.json ./
RUN npm install
RUN npx playwright install chromium
COPY . .

EXPOSE 3000
CMD ["node", "index.js"]
