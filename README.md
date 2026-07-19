# VIAstudyWiz — itslearning extension

Browser extension der automatiserer indsamling af lektionsplaner og
undervisningsmaterialer fra via.itslearning.com (VIA University College).

Del af VIAstudyWiz-pipelinen. Kontekst, research og arkitekturbeslutninger
ligger i ValdiVault:
`10_Projects/VIAstudyWiz/06-handover-frisk-chat.md` (arbejdsdokument)
`10_Projects/VIAstudyWiz/05-teknisk-research-itslearning-api.md` (fuld research-log)

## Status

Research afsluttet — API-flade og download-kæder for PDF og Office-filer
(.docx/.pptx/.xlsx) er begge kortlagt og løst. Se handover-noten for
fund-oversigt og resterende åbne punkter. Build-fase starter nu, tracket
som GitHub Issues i dette repo.

## Sikkerhed

Ingen session-cookies, antiforgery-tokens eller andre secrets må committes.
De skal læses dynamisk fra browserens egen session ved runtime.
