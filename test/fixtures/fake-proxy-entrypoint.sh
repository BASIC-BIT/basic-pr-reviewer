#!/bin/sh
set -eu
umask 077
openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/ca.key -out /tmp/ca.pem -days 1 -subj /CN=synthetic-reviewer-egress >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -keyout /tmp/origin.key -out /tmp/origin.csr -subj /CN=api.anthropic.com >/dev/null 2>&1
printf 'subjectAltName=DNS:api.anthropic.com\n' > /tmp/origin.ext
openssl x509 -req -in /tmp/origin.csr -CA /tmp/ca.pem -CAkey /tmp/ca.key -CAcreateserial -out /tmp/origin.pem -days 1 -extfile /tmp/origin.ext >/dev/null 2>&1
if [ "${SYNTHETIC_BAD_CERT:-}" = 1 ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/origin.key -out /tmp/origin.pem -days 1 -subj /CN=api.anthropic.com >/dev/null 2>&1
fi
/usr/lib/squid/security_file_certgen -c -s /tmp/ssl_db -M 4MB >/dev/null
cp /etc/squid/squid.conf /tmp/squid.conf
printf '\ncache_peer 127.0.0.1 parent 8080 0 no-query\nnever_direct allow all\ntls_outgoing_options cafile=/tmp/ca.pem\n' >> /tmp/squid.conf
node /fixture/fake-provider.mjs &
exec squid -N -f /tmp/squid.conf
