FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# System deps
RUN apt-get update -y && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Python deps
COPY backend/django_app/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# App source
COPY backend/django_app/src /app

# Data volume for sqlite
VOLUME ["/data"]
ENV SQLITE_FILE=/data/data.sqlite

# Ports and env
ENV PORT=8080
EXPOSE 8080

# Entrypoint: migrate and run gunicorn
CMD sh -c "python manage.py migrate --noinput && \
           gunicorn ttbackend.wsgi:application --bind 0.0.0.0:${PORT} --workers 3 --timeout 60"
