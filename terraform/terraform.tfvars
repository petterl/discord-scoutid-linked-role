# Azure Configuration
project_name = "discord-scoutid"
location     = "swedencentral" # Sweden Central region

# Scaling Configuration (min_replicas = 0 allows scale to zero for cost savings)
min_replicas = 0
max_replicas = 2

# Docker Image Configuration
docker_image_name = "discord-scoutid-linked-role"
docker_image_tag  = "latest"
