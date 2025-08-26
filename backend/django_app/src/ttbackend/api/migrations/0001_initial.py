from django.db import migrations, models
import django.db.models.deletion
from django.conf import settings

class Migration(migrations.Migration):
    initial = True

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='Task',
            fields=[
                ('id', models.CharField(primary_key=True, serialize=False, max_length=64)),
                ('title', models.CharField(max_length=255)),
                ('notes', models.TextField(blank=True, default='')),
                ('everyDays', models.IntegerField()),
                ('nextDue', models.CharField(max_length=10)),
                ('remindAt', models.CharField(max_length=5)),
                ('priority', models.BooleanField(default=False)),
                ('lastCompleted', models.CharField(blank=True, null=True, max_length=64)),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='tasks', to=settings.AUTH_USER_MODEL)),
            ],
        ),
        migrations.CreateModel(
            name='PushSubscription',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('endpoint', models.TextField()),
                ('p256dh', models.TextField()),
                ('auth', models.TextField()),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='push_subs', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'unique_together': {('user', 'endpoint')},
            },
        ),
    ]
