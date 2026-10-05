# PsicoLogo – immagine del server
FROM node:22-slim
WORKDIR /app
COPY scripts ./scripts
COPY public ./public
COPY server.js pdf.js LICENSE ./
# Scarica i caratteri una sola volta, così la pagina non chiama server esterni (Google Fonts).
RUN node scripts/fetch-fonts.js
ENV NODE_ENV=production DATA_DIR=/data PORT=3000 HOST=0.0.0.0
USER node
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
