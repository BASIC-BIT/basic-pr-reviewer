ARG WORKER_IMAGE
FROM ${WORKER_IMAGE}
USER 0:0
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
USER 1000:1000
ENTRYPOINT ["node"]
