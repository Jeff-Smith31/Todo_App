from django.contrib import admin
from django.urls import path
from ttbackend.api import views as api

urlpatterns = [
    path('admin/', admin.site.urls),

    # Health and ping (accept with and without trailing slash)
    path('healthz', api.healthz),
    path('healthz/', api.healthz),
    path('api/ping', api.ping),
    path('api/ping/', api.ping),

    # Auth endpoints
    path('api/auth/register', api.register),
    path('api/auth/register/', api.register),
    path('api/auth/login', api.login_view),
    path('api/auth/login/', api.login_view),
    path('api/auth/logout', api.logout_view),
    path('api/auth/logout/', api.logout_view),
    path('api/auth/me', api.me),
    path('api/auth/me/', api.me),

    # Tasks collection and detail
    path('api/tasks', api.tasks),
    path('api/tasks/', api.tasks),
    path('api/tasks/<str:task_id>', api.task_detail),
    path('api/tasks/<str:task_id>/', api.task_detail),

    # Push subscription
    path('api/push/vapid-public-key', api.vapid_public_key),
    path('api/push/vapid-public-key/', api.vapid_public_key),
    path('api/push/subscribe', api.push_subscribe),
    path('api/push/subscribe/', api.push_subscribe),
]