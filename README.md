# Influlink

Protótipo front-end de um marketplace que conecta **marcas** a **divulgadores (influenciadores)**.
Arquivo único (`index.html`), sem build e sem dependências — basta abrir no navegador.

## O que tem
- Home, Explorar (divulgadores e empresas) com filtros por nicho, seguidores, estado e valor
- Campanhas: marcas publicam briefing/orçamento, divulgadores se candidatam
- Cadastro em etapas com termos, CEP com preenchimento automático de endereço (ViaCEP) e escolha entre "Quero divulgar" / "Quero ser divulgado"
- Lista de 800 segmentos com autocomplete
- Filtro de linguagem em tempo real no chat
- Pagamento em custódia com simulação do split 9% / 91%
- Configurações com endereço e dados bancários

## Limitações (é um protótipo)
- Login com Google é **simulado** (seletor de contas fictício); OAuth real exige backend e credenciais do Google Cloud.
- Pagamentos, contratos e moderação de imagem são maquetes visuais; split real precisa de um gateway (ex.: Pagar.me, Mercado Pago).
- A persistência usa `window.storage`, disponível apenas dentro de artefatos do Claude. Fora dele (ex.: GitHub Pages) os dados não são gravados, a menos que se troque por `localStorage` ou por um backend.

## Rodar
Abra `index.html` no navegador.
