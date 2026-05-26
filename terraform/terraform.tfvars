# Azure Configuration
project_name    = "discord-scoutid"
location        = "swedencentral" # Sweden Central region
subscription_id = "d4887907-2e73-4465-9fe3-44c82ed016d6"
tenant_id       = "317a47ba-fd32-41b8-8ebe-310a1adc9863"

# Scaling Configuration (min_replicas = 0 allows scale to zero for cost savings)
min_replicas = 0
max_replicas = 2

# Docker Image Configuration
docker_image_name = "discord-scoutid-linked-role"
docker_image_tag  = "latest"

# Role configuration
scoutnet_event_role        = "WSJ-event"
scoutnet_fee_roles         = "25694:deltagare,27561:deltagare,25696:ist,25702:ist-direktresa,33293:ledare,34850:ledare,27560:ledare,25695:ledare,25697:cmt,25693:cmt"
scoutnet_division_roles    = "deltagare:88168:Deltagare-{div}:Deltagare-Väntande,ist:88168:IST-Patrull-{div}:IST-Väntande,ledare:107592:Ledare-{div}:Ledare-Väntande"
scoutnet_nickname_suffixes = "deltagare:{div}:,ledare:AL{div}:AL,ist:IST-{div}:IST,ist-direktresa::IST,cmt::CMT"
