from django.db import models
from django.contrib.auth.models import User

class Task(models.Model):
    id = models.CharField(primary_key=True, max_length=64)
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='tasks')
    title = models.CharField(max_length=255)
    notes = models.TextField(blank=True, default='')
    everyDays = models.IntegerField()
    nextDue = models.CharField(max_length=10)  # YYYY-MM-DD
    remindAt = models.CharField(max_length=5)  # HH:MM
    priority = models.BooleanField(default=False)
    lastCompleted = models.CharField(max_length=64, blank=True, null=True)

class PushSubscription(models.Model):
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='push_subs')
    endpoint = models.TextField()
    p256dh = models.TextField()
    auth = models.TextField()

    class Meta:
        unique_together = ('user', 'endpoint')
