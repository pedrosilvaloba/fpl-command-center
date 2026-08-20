# FPL Command Center

Painel de gestão da equipa de Fantasy Premier League — 2026/27. Dados reais
e ao vivo da API oficial (não-oficial/pública) da FPL, servidos por um
backend próprio para contornar as limitações de CORS, com um motor de
recomendações transparente (não caixa-negra) construído a partir de
investigação sobre como os melhores gestores mundiais realmente jogam.

## Porquê esta arquitetura

Duas coisas descobertas durante a construção, que moldaram as decisões
técnicas abaixo:

1. **A API da FPL não envia cabeçalhos CORS.** Um browser não consegue
   chamá-la diretamente a partir de uma página estática — por isso este
   projeto é uma app Next.js com rotas de API (`app/api/fpl/*`) que fazem
   de proxy: o browser fala com o nosso backend, o nosso backend fala com
   `fantasy.premierleague.com/api`.
2. **JSON grande não deve ser "lido" por um modelo de IA.** `bootstrap-static`
   tem ~700 jogadores e vários MB — resumir isso com um modelo pequeno
   produz dados inventados (testámos e confirmámos: trocou o clube de
   jogadores reais). Por isso todo o acesso a dados em produção é feito por
   código determinístico (`fetch` + `JSON.parse`), nunca por um modelo a
   "interpretar" a resposta.

## Estrutura

```
app/
  page.tsx                    Dashboard principal (server component)
  api/fpl/bootstrap/route.ts  Proxy para /bootstrap-static/
  api/fpl/fixtures/route.ts   Proxy para /fixtures/
  api/fpl/entry/[id]/route.ts Proxy para /entry/{id}/ + histórico
  api/fpl/league/[id]/route.ts Proxy para /leagues-classic/{id}/standings/
lib/
  types.ts        Tipos TypeScript para as respostas da API da FPL
  fpl-client.ts   Cliente HTTP server-side para a API da FPL (com cache)
  fdr.ts          Construção do fixture ticker / dificuldade de calendário
  recommend.ts    Motor de pontuação, sugestão de equipa e capitão
  strategy.ts     Playbook e regras 2026/27 (conteúdo da investigação)
components/
  CountdownTimer.tsx  Contagem decrescente até ao deadline (client)
  FixtureTicker.tsx   Tabela de calendário com chips de dificuldade
  PlayerTable.tsx     Tabela reutilizável de jogadores pontuados
  MyTeamPanel.tsx     A Minha Equipa — liga um Team ID real (client)
```

## O que já funciona (v1 + v1.1)

- Dados 100% reais e ao vivo — preço, forma, posse, pontos, calendário —
  vindos diretamente da API oficial, sem qualquer valor inventado ou
  copiado deste chat.
- **A Minha Equipa** — introduz o teu Team ID (guardado neste browser) e vês
  o teu plantel real, capitão, banco, valor e rank, com sugestões de
  transferência calculadas contra o teu plantel verdadeiro (não genéricas).
- Fixture ticker (próximas 5 jornadas) com a dificuldade oficial da FPL.
- Sugestão de equipa (15 jogadores, £100m, 2-5-5-3, máx. 3 por clube) e de
  onze inicial + capitão/vice, através de uma heurística transparente
  (ver comentários em `lib/recommend.ts`) que pesa preço/posse/calendário
  antes da época começar, e forma/pontos por jogo depois.
- Diferenciais (jogadores com posse < 10%) e melhores escolhas por posição.
- Playbook de estratégia e cheat sheet de regras, com fontes citadas.

## Roadmap (próximas iterações, a construir contigo)

Em ordem de prioridade, a validar em conjunto antes de cada etapa:

1. **As Minhas Ligas** — comparação com rivais nas tuas ligas privadas
   (precisa de sessão autenticada da FPL — ver ponto 3).
2. **Shadow Team** — um plantel paralelo, guardado no backend (não só no
   browser), para simulares transferências/capitães/chips sem tocar na
   equipa real. Precisa de uma camada de persistência (Vercel KV/Upstash
   Redis, plano gratuito).
3. **Login FPL + autopilot de transferências** — decidiste avançar com
   automação total (credenciais guardadas, execução automática). Isto usa
   um fluxo de login não-oficial (`users.premierleague.com/accounts/login/`)
   que a Premier League pode alterar sem aviso. Antes de implementar:
   - As credenciais serão guardadas **encriptadas** no backend (nunca em
     texto simples, nunca expostas ao frontend).
   - Vou propor que **hits (-4) e uso de chips fiquem sempre atrás de uma
     aprovação explícita tua**, mesmo em modo autopilot — são decisões
     pouco frequentes e de alto impacto (só tens 2 Wildcards/Free
     Hits/Bench Boosts/Triple Captains a época toda), o risco de um erro
     automático aí é desproporcional ao ganho de conveniência. Transferências
     "de rotina" dentro do orçamento de transferências grátis podem ser
     automáticas.
   - Um interruptor geral (armar/desarmar) e um registo de auditoria de
     cada ação automática, com a razão por trás da decisão.
   - Vamos falar sobre isto em detalhe antes de mexer em credenciais reais.
4. **Otimizador real** — substituir a heurística gananciosa em
   `buildSuggestedSquad` por um solver de programação linear (abordagem
   usada pela FPL Review e pela maioria das ferramentas open-source da
   comunidade), para uma equipa genuinamente ótima dentro do orçamento.
5. **Preditor de mudanças de preço e monitor de notícias/lesões.**

## Deploy (Vercel, plano gratuito)

```bash
# 1. Instalar dependências localmente (já feito neste projeto)
npm install

# 2. Testar localmente
npm run dev
# abre http://localhost:3000

# 3. Publicar no GitHub (se ainda não estiver num repositório)
git add -A
git commit -m "FPL Command Center v1"
git remote add origin <o-teu-repositorio-github>
git push -u origin main

# 4. Deploy na Vercel
npx vercel        # segue o login/setup interativo na primeira vez
npx vercel --prod # publica em produção
```

Ou, mais simples: importa o repositório diretamente em
[vercel.com/new](https://vercel.com/new) — a Vercel deteta automaticamente
que é uma app Next.js, não precisa de nenhuma variável de ambiente para
esta v1 (só passará a precisar quando ligarmos autenticação/KV nos
próximos passos).

## Notas honestas

- A API da FPL é pública mas **não-oficial e não documentada** pela
  Premier League — pode mudar sem aviso. O código foi escrito para falhar
  de forma controlada (erros claros) em vez de rebentar silenciosamente.
- A dificuldade de calendário (FDR) usada é a oficial da FPL, conhecida por
  ser algo grosseira (baseada em posição na liga). Um FDR próprio, baseado
  em Elo/diferencial de xG por equipa, está no roadmap.
- A sugestão de equipa é uma heurística gananciosa, não um ótimo
  matemático — é honesta sobre isso na própria interface.
