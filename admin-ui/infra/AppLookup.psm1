# `az ad app list --display-name <name>` matches by prefix, so the gateway's registration <name> and the console's
# <name>-admin-ui-signin both match <name>, in no guaranteed order. The deploy takes the registration whose name is
# exactly <name>: its appId, nothing when there is none, and an error when several share the name.
function Select-AppIdByName {
    param([object[]]$Apps, [Parameter(Mandatory = $true)][string]$Name)
    $exact = @($Apps | Where-Object { $_ -and $_.displayName -ceq $Name })
    if ($exact.Count -gt 1) { throw "$($exact.Count) app registrations are named $Name; rename or delete the extra ones, then run again." }
    if ($exact.Count -eq 1) { return $exact[0].appId }
}

Export-ModuleMember -Function Select-AppIdByName
