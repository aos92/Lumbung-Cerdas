FROM docker.io/library/node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=9655

WORKDIR /app

# Tanpa dependensi npm. Rahasia (SHARED_SECRET, NVIDIA_API_KEY) diberikan lewat env saat run.
COPY --chown=1000:1000 package.json server.js ./
COPY --chown=1000:1000 lib/ ./lib/

USER 1000:1000

EXPOSE 9655

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "-e", "const http=require('http');const req=http.get({host:'127.0.0.1',port:process.env.PORT||9655,path:'/health'},res=>{res.resume();process.exit(res.statusCode===200?0:1)});req.on('error',()=>process.exit(1));req.setTimeout(4000,()=>{req.destroy();process.exit(1)})"]

CMD ["node", "server.js"]
