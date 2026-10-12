# ItsWiz (spike)

Go/no-go-test: kan VIAstudyWiz' itslearning-høst køre inde i Obsidian i stedet for Chrome?

Testen beviser fire ting, som `viastudywiz-extension/background.js` i dag har brug for Chrome til:
login på itslearning i en indlejret browser, REST-API'et med den session, PDF-kæden og Office-kæden
(itslearnings filecache, native download eller WOPI). Den skriver kun til `ItsWiz-test/` i vaulten.

## Brug

1. Symlink ind i vaulten (gjort for ViaVault):
   `mkdir -p ~/ViaVault/.obsidian/plugins/itswiz && ln -sf "$PWD"/plugin/{main.js,manifest.json} ~/ViaVault/.obsidian/plugins/itswiz/` (fra repo-roden)
2. Obsidian → Indstillinger → Community plugins → slå **ItsWiz** til.
3. Klik eksamenshatten i venstre bjælke, log ind på itslearning i fanen.
4. Klik **Kør test**. Resultatet står i `ItsWiz-test/rapport.md`.

Kun desktop. Ingen build, ingen dependencies.
