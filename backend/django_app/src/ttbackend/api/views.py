import json
import os
from django.http import JsonResponse, HttpResponseNotAllowed, HttpResponse
from django.views.decorators.csrf import csrf_exempt
from django.contrib.auth import authenticate, login, logout
from django.contrib.auth.models import User
from django.contrib.auth.decorators import login_required
from django.utils.decorators import method_decorator
from django.views.decorators.http import require_http_methods
from ttbackend.api.models import Task, PushSubscription

SERVICE_NAME = 'ticktock-backend-django'

@require_http_methods(["GET"]) 
def healthz(request):
    return JsonResponse({"ok": True})

@require_http_methods(["GET"]) 
def ping(request):
    return JsonResponse({"ok": True, "service": SERVICE_NAME})

@csrf_exempt
@require_http_methods(["POST"]) 
def register(request):
    try:
        body = json.loads(request.body or b"{}")
    except Exception:
        body = {}
    email = (body.get('email') or '').strip().lower()
    password = body.get('password') or ''
    if not email or not password or len(password) < 8:
        return JsonResponse({"error": "Invalid input"}, status=400)
    if User.objects.filter(username=email).exists():
        return JsonResponse({"error": "Email already registered"}, status=409)
    user = User.objects.create_user(username=email, email=email, password=password)
    login(request, user)
    return JsonResponse({"ok": True, "user": {"id": user.id, "email": email}})

@csrf_exempt
@require_http_methods(["POST"]) 
def login_view(request):
    try:
        body = json.loads(request.body or b"{}")
    except Exception:
        body = {}
    email = (body.get('email') or '').strip().lower()
    password = body.get('password') or ''
    user = authenticate(request, username=email, password=password)
    if user is None:
        return JsonResponse({"error": "Invalid credentials"}, status=401)
    login(request, user)
    return JsonResponse({"ok": True, "user": {"id": user.id, "email": email}})

@csrf_exempt
@require_http_methods(["POST"]) 
def logout_view(request):
    logout(request)
    return JsonResponse({"ok": True})

@require_http_methods(["GET"]) 
def me(request):
    if request.user.is_authenticated:
        return JsonResponse({"user": {"id": request.user.id, "email": request.user.username}})
    return JsonResponse({"user": None})

@csrf_exempt
@require_http_methods(["GET", "POST"]) 
def tasks(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "Unauthorized"}, status=401)
    if request.method == 'GET':
        items = [{
            "id": t.id,
            "title": t.title,
            "notes": t.notes,
            "everyDays": t.everyDays,
            "nextDue": t.nextDue,
            "remindAt": t.remindAt,
            "priority": t.priority,
            "lastCompleted": t.lastCompleted,
        } for t in Task.objects.filter(user=request.user)]
        return JsonResponse({"tasks": items})
    else:
        try:
            body = json.loads(request.body or b"{}")
        except Exception:
            body = {}
        title = (body.get('title') or '').strip()
        if not title:
            return JsonResponse({"error": "title required"}, status=400)
        task_id = body.get('id') or _random_id()
        t = Task(
            id=task_id,
            user=request.user,
            title=title,
            notes=body.get('notes') or '',
            everyDays=int(body.get('everyDays') or 1),
            nextDue=body.get('nextDue') or '',
            remindAt=body.get('remindAt') or '09:00',
            priority=bool(body.get('priority') or False),
            lastCompleted=body.get('lastCompleted') or None,
        )
        t.save()
        return JsonResponse({"id": task_id}, status=201)

@csrf_exempt
@require_http_methods(["PUT", "DELETE"]) 
def task_detail(request, task_id: str):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "Unauthorized"}, status=401)
    try:
        t = Task.objects.get(user=request.user, pk=task_id)
    except Task.DoesNotExist:
        return JsonResponse({"error": "Task not found"}, status=404)
    if request.method == 'DELETE':
        t.delete()
        return JsonResponse({"ok": True})
    else:
        try:
            body = json.loads(request.body or b"{}")
        except Exception:
            body = {}
        t.title = (body.get('title') or t.title)
        t.notes = body.get('notes', t.notes) or ''
        if 'everyDays' in body:
            t.everyDays = int(body.get('everyDays') or t.everyDays)
        t.nextDue = body.get('nextDue', t.nextDue) or t.nextDue
        t.remindAt = body.get('remindAt', t.remindAt) or t.remindAt
        if 'priority' in body:
            t.priority = bool(body.get('priority'))
        t.lastCompleted = body.get('lastCompleted', t.lastCompleted)
        t.save()
        return JsonResponse({"ok": True})

@require_http_methods(["GET"]) 
def vapid_public_key(request):
    key = os.environ.get('WEB_PUSH_PUBLIC_KEY', '')
    if not key:
        return JsonResponse({"error": "Push not configured"}, status=503)
    return JsonResponse({"key": key})

@csrf_exempt
@require_http_methods(["POST", "DELETE"]) 
def push_subscribe(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "Unauthorized"}, status=401)
    try:
        body = json.loads(request.body or b"{}")
    except Exception:
        body = {}
    endpoint = (body.get('endpoint') or '').strip()
    if not endpoint:
        return JsonResponse({"error": "endpoint required"}, status=400)
    if request.method == 'DELETE':
        PushSubscription.objects.filter(user=request.user, endpoint=endpoint).delete()
        return JsonResponse({"ok": True})
    keys = body.get('keys') or {}
    p256dh = keys.get('p256dh') or ''
    auth = keys.get('auth') or ''
    try:
        sub, created = PushSubscription.objects.get_or_create(user=request.user, endpoint=endpoint, defaults={'p256dh': p256dh, 'auth': auth})
        if not created:
            sub.p256dh = p256dh
            sub.auth = auth
            sub.save()
        return JsonResponse({"ok": True})
    except Exception:
        return JsonResponse({"error": "Failed to save subscription"}, status=500)

# Utils
import random, string

def _random_id():
    try:
        import uuid
        return str(uuid.uuid4())
    except Exception:
        return 'id-' + ''.join(random.choices(string.ascii_lowercase + string.digits, k=10))
