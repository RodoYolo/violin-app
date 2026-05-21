from django.urls import path
from . import views

urlpatterns = [
    path('', views.index, name='index'),
    path('api/solve/', views.solve_view, name='solve'),
    path('api/search/', views.search_view, name='search'),
    path('api/import/', views.import_view, name='import'),
]
