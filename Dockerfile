FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# src/ is the app; forms/ holds the blank intake PDFs attached to welcome emails
# (services/email.js reads ../../forms at send time).
COPY src ./src
COPY forms ./forms

EXPOSE 3000
CMD ["node", "src/index.js"]
