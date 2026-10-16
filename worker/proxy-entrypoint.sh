#!/bin/sh
set -eu
umask 077
openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/ca.key -out /tmp/ca.pem -days 1 -subj /CN=reviewer-pass-egress >/dev/null 2>&1
/usr/lib/squid/security_file_certgen -c -s /tmp/ssl_db -M 4MB >/dev/null
exec squid -N -f /etc/squid/squid.conf
