# Raw-directive smoke for a manual launch (no header: the Node runner strips it anyway).
# Mewgenics.exe -savesuffix dev -enable_debugconsole true -dev_mode true -mewtest "<this file>" -mewtest_hide 0 -mewtest_timeout 60000 -modpaths "<repo>\mods\jokers-luck"
log "smoke"
wait frames 120
cmd this_command_does_not_exist_xyz
expect console "No command named \"this_command_does_not_exist_xyz\" found"
cmd spawn
expect console "needs at least"
cmd listcmds
expect console "listcmds" within 5
dump
quit
