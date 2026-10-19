FROM --platform=linux/amd64 node:24.22.0-bookworm-slim@sha256:ec857ea6bb60cb3d0fa4d97495590c5fe7d51be8572c307b55957eeb06569cf7
RUN apt-get update && apt-get install -y --no-install-recommends squid-openssl=5.7-2+deb12u6 openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY worker/squid.conf /etc/squid/squid.conf
COPY worker/proxy-entrypoint.sh /proxy-entrypoint.sh
USER 1000:1000
ENTRYPOINT ["sh", "/proxy-entrypoint.sh"]
