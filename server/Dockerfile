FROM python:3.12-slim

WORKDIR /srv

# The whole package, not one file. This copied gen_server.py alone, so
# the routing, limit and review modules it imports were simply absent and
# the container failed on the first request that needed one of them.
COPY *.py /srv/server/
RUN touch /srv/server/__init__.py

ENV STUDIO_HOST=0.0.0.0
ENV STUDIO_PORT=8787
EXPOSE 8787

# Not root: this listens on a public port.
RUN useradd --create-home --shell /usr/sbin/nologin studio \
 && chown -R studio:studio /srv
USER studio

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD python -c "import os,sys,urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('STUDIO_PORT','8787')+'/health',timeout=4).status==200 else 1)"

# As a package, so the imports between modules resolve.
CMD ["python", "-m", "server.gen_server"]
