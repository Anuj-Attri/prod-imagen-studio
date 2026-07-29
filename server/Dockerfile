FROM python:3.12-slim
WORKDIR /srv
COPY gen_server.py .
ENV STUDIO_HOST=0.0.0.0
EXPOSE 8787
CMD ["python", "gen_server.py"]
