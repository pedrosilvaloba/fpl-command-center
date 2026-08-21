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
  api/fpl/entry/[id]/picks/route.ts Proxy para /entry/{id}/event/{gw}/picks/
  api/fpl/league/[id]/route.ts Proxy para /leagues-classic/{id}/standings/
  api/shadow-team/route.ts    Guarda/lê a Shadow Team no Upstash Redis (quando ligado)
lib/
  types.ts        Tipos TypeScript para as respostas da API da FPL
  fpl-client.ts   Cliente HTTP server-side para a API da FPL (com cache)
  fdr.ts          Construção do fixture ticker / dificuldade de calendário
  recommend.ts    Motor de pontuação, onze ideal, capitão e heurística de recurso
  matchmodel.ts   Modelo de golos esperados por equipa/jogo (Poisson) e clean sheets
  oddsapi.ts      Cliente da The Odds API — probabilidades de mercado (opcional)
  schedule.ts     Deteção de jornadas duplas e em branco por equipa
  optimizer.ts    Otimizador real (programação linear) da equipa sugerida
  pricewatch.ts   Preditor de mudanças de preço e monitor de notícias/lesões
  strategy.ts     Playbook e regras 2026/27 (conteúdo da investigação)
  constants.ts    Team ID e League ID por omissão desta instalação pessoal
  kv.ts           Cliente Upstash Redis (com fallback gracioso se não ligado)
components/
  CountdownTimer.tsx  Contagem decrescente até ao deadline (client)
  FixtureTicker.tsx   Tabela de calendário com chips de dificuldade
  PlayerTable.tsx     Tabela reutilizável de jogadores pontuados
  MyTeamPanel.tsx     A Minha Equipa — liga um Team ID real (client)
  ShadowTeamPanel.tsx Shadow Team — simulador de plantel (client, Redis + localStorage)
```

## O que já funciona (v1.7)

- Dados 100% reais e ao vivo — preço, forma, posse, pontos, calendário —
  vindos diretamente da API oficial, sem qualquer valor inventado ou
  copiado deste chat.
- **Odds de mercado como sinal de contexto (opcional)** — quando ligada
  (ver "Deploy" abaixo), a app vai buscar probabilidades implícitas de
  casas de apostas para os jogos da Premier League e usa-as para ajustar
  o modelo de golos esperados abaixo. É a forma de captar fatores não
  estatísticos (mudança de treinador, regresso de um jogador-chave,
  ajustes táticos) e a opinião agregada de milhares de analistas — sem
  fazer nós próprios qualquer análise subjetiva de texto. Sem chave
  configurada, a app funciona normalmente só com o modelo estatístico.
  Ver `lib/oddsapi.ts`.
- **Modelo de golos esperados por equipa** — a base de toda a pontuação
  deixou de ser um único dígito de dificuldade de calendário (1 a 5,
  igual para todos os jogadores da mesma equipa). Usa as próprias
  classificações de força de ataque/defesa (casa/fora) que a FPL já
  publica, através de um modelo de Poisson (a mesma família usada pela
  maioria dos modelos públicos de previsão de futebol), para calcular,
  jogo a jogo, golos esperados e probabilidade de clean sheet reais.
  Defesas/guarda-redes são agora pontuados pela probabilidade de clean
  sheet do seu jogo específico; médios/avançados pelos golos esperados da
  própria equipa nesse jogo — não pelo mesmo número genérico de calendário
  que todos os colegas de equipa recebiam antes. Ver `lib/matchmodel.ts`.
- **Deteção de jornadas duplas e em branco (novo)** — a app varre o
  calendário oficial e identifica, por equipa, quando vai ter dois jogos
  na mesma jornada (dupla) ou nenhum (em branco), numa nova secção
  "Jornadas Duplas e Brancas". Isto alimenta diretamente a pontuação: a
  janela de próximas jornadas usada para pontuar deixou de ser uma média
  simples (que dilui uma dupla e esconde uma branca) e passou a somar os
  jogos esperados dentro da janela — uma dupla vale agora o dobro, uma
  branca vale zero nessa jornada, tal como no jogo real. Jogadores
  afetados recebem uma nota explícita ("inclui jornada dupla/em branco
  nas próximas N jornadas") nas razões da pontuação. Como as duplas/brancas
  só costumam ficar confirmadas a algumas semanas de distância, é normal
  esta secção aparecer vazia no início da época — não é um erro. Ver
  `lib/schedule.ts` e `windowExpectation` em `lib/matchmodel.ts`.
- **A Minha Equipa** — introduz o teu Team ID (guardado neste browser, com
  o teu por omissão) e vês o teu plantel real, capitão, banco, valor e
  rank, com sugestões de transferência calculadas contra o teu plantel
  verdadeiro (não genéricas).
- **A Minha Liga** — classificação ao vivo da tua liga privada ("Haal of
  Fame", #369689), com a tua linha destacada.
- **Shadow Team** — monta um plantel paralelo (respeitando orçamento,
  2-5-5-3 e máx. 3 por clube) para testares ideias de transferência sem
  tocar na equipa real, com onze ideal e capitão calculados automaticamente.
  Sincroniza entre dispositivos assim que a integração Upstash Redis
  estiver ligada na Vercel (passo opcional — ver "Deploy" abaixo);
  até lá, ou se algo falhar, continua a funcionar guardado só neste browser.
- **Otimizador real** — a Equipa Sugerida deixou de ser uma heurística
  gananciosa: agora resolve um problema de programação linear inteira
  (via `javascript-lp-solver`) que encontra a combinação matematicamente
  ótima de 15 jogadores para a pontuação do motor, respeitando £100m,
  2-5-5-3 e máx. 3 por clube. Se o solver falhar por algum motivo, a app
  recua para a heurística anterior em vez de partir a página — e diz-te
  qual dos dois métodos usou.
- **Preditor de Mudanças de Preço** — estima subidas/descidas prováveis
  ainda hoje a partir das transferências líquidas de cada jogador. É uma
  aproximação transparente (a FPL não publica o algoritmo real), pensada
  para te ajudar a decidir se vale a pena adiantar uma transferência.
- **Monitor de Notícias/Lesões** — lista todos os jogadores com uma nota
  ativa (lesão, dúvida, suspensão), ordenados por posse para os mais
  relevantes aparecerem primeiro, com destaque para notícias das últimas 48h.
- Fixture ticker (próximas 5 jornadas) com a dificuldade oficial da FPL.
- Diferenciais (jogadores com posse < 10%) e melhores escolhas por posição.
- Playbook de estratégia e cheat sheet de regras, com fontes citadas.

## Roadmap (próximas iterações)

1. **Simulação contra os rivais da liga (Camada 2)** — em vez de otimizar
   só para maximizar os teus pontos esperados, a FPL deixa consultar o
   plantel de qualquer gestor pelo Team ID — incluindo os da Haal of Fame.
   A ideia: simular semana a semana o teu resultado provável contra cada
   rival específico, e recomendar a jogada que maximiza a probabilidade de
   os ultrapassares ou de manteres distância — não a jogada genericamente
   "melhor". Se estás atrás, a jogada certa aumenta variância
   (diferenciais); se estás à frente, reduz variância (template). É a
   próxima peça a construir.
2. **Aprendizagem entre estratégias (Camada 3)** — usar a Shadow Team para
   correr várias estratégias em paralelo (template, diferenciais
   agressivos, só calendário, só modelo de golos esperados) e, à medida
   que jornadas reais vão sendo jogadas, medir qual delas está mesmo a
   funcionar esta época e inclinar a recomendação principal para essa.
   Só começa a fazer sentido depois de haver resultados reais — a própria
   época dita esta ordem.
3. **Login FPL + autopilot de transferências** — o autopilot em si.
   Decidiste avançar com automação total (credenciais guardadas, execução
   automática). Isto usa um fluxo de login não-oficial
   (`users.premierleague.com/accounts/login/`) que a Premier League pode
   alterar ou bloquear sem aviso — incluindo proteções anti-bot que podem
   simplesmente impedir um login automático de funcionar de forma fiável;
   não há garantia de que este fluxo continue a funcionar a prazo. Antes
   de escrever qualquer código que toque em credenciais reais, o desenho
   de segurança concreto (não só o conceito) fica combinado contigo:
   - As credenciais serão guardadas **encriptadas** no backend (nunca em
     texto simples, nunca expostas ao frontend).
   - **Hits (-4) e uso de chips ficam sempre atrás de uma aprovação
     explícita tua**, mesmo em modo autopilot — são decisões pouco
     frequentes e de alto impacto (só tens 2 Wildcards/Free
     Hits/Bench Boosts/Triple Captains a época toda), o risco de um erro
     automático aí é desproporcional ao ganho de conveniência.
     Transferências "de rotina" dentro do orçamento de transferências
     grátis podem ser automáticas.
   - Um interruptor geral (armar/desarmar) e um registo de auditoria de
     cada ação automática, com a razão por trás da decisão.
   - Decidido: o pedido de aprovação aparece dentro da app e é acompanhado
     de uma notificação por email. Se não responderes antes do deadline, a
     app **não faz nada** — a transferência/chip pendente simplesmente não
     se aplica, em vez de agir sozinha sem a tua confirmação.
   - Ainda falta: construir isto de facto. Fica depois das Camadas 2 e 3
     acima — é o item de maior risco (credenciais reais), por isso o
     desenho já fechado não significa pressa em escrever o código.

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
que é uma app Next.js. Não precisa de nenhuma variável de ambiente para
funcionar — o passo abaixo é opcional.

### Passo opcional: sincronizar a Shadow Team entre dispositivos

Sem isto a Shadow Team continua a funcionar normalmente, só que guardada
apenas no browser onde a usaste. Para sincronizar entre telemóvel/computador:

1. No painel do projeto na Vercel, vai a **Storage** → **Create Database** →
   escolhe a integração **Upstash** (ou procura "Redis" no Marketplace) →
   plano gratuito.
2. A Vercel liga automaticamente as variáveis de ambiente necessárias ao
   projeto — não precisas de copiar nada à mão.
3. No deploy seguinte, a Shadow Team passa a mostrar "Sincronizado entre
   dispositivos" em vez de "Guardado só neste browser".

### Passo opcional: ligar odds de mercado

Sem isto a app funciona normalmente, só com o modelo estatístico próprio.
Para incluir odds de mercado no modelo de golos esperados:

1. Cria uma conta gratuita em [the-odds-api.com](https://the-odds-api.com/)
   (plano gratuito: 500 pedidos/mês, mais do que suficiente — a app só
   consulta a cada 12h).
2. Copia a tua chave de API (aparece no painel depois de criares a conta).
3. No projeto na Vercel: **Settings** → **Environment Variables** → adiciona
   uma variável chamada `ODDS_API_KEY` com o valor da tua chave → grava.
4. Faz um novo deploy (qualquer alteração e novo push serve, ou usa o botão
   "Redeploy" na Vercel) para a variável ficar ativa.
5. Na secção "Equipa Sugerida" da app, a nota por baixo do capitão passa a
   dizer "Pontuação enriquecida com odds de mercado" em vez de "a correr só
   com o modelo estatístico".

## Notas honestas

- A API da FPL é pública mas **não-oficial e não documentada** pela
  Premier League — pode mudar sem aviso. O código foi escrito para falhar
  de forma controlada (erros claros) em vez de rebentar silenciosamente.
- A dificuldade de calendário (FDR) usada é a oficial da FPL, conhecida por
  ser algo grosseira (baseada em posição na liga). Um FDR próprio, baseado
  em Elo/diferencial de xG por equipa, está no roadmap.
- O otimizador encontra a equipa matematicamente ótima *para a pontuação
  do motor v1* — continua tão bom (ou limitado) quanto essa pontuação. Por
  performance, resolve sobre um conjunto reduzido de candidatos por posição
  (os melhores por pontuação + os mais baratos, ver `lib/optimizer.ts`) em
  vez de todos os ~600 jogadores — na prática cobre o essencial sem risco
  de exceder o tempo limite da Vercel.
- O preditor de preços é uma estimativa heurística, não a fórmula real da
  FPL (nunca publicada) — trata como um sinal para decidir, não como certeza.
- O ajuste por odds de mercado é uma aproximação (ver `applyMarketTilt` em
  `lib/matchmodel.ts`): em vez de recalcular o par de golos esperados que
  reproduziria exatamente as probabilidades do mercado (um problema
  numérico mais pesado, deixado para depois), desloca os números do nosso
  próprio modelo na direção do mercado, com um limite de ±40% para um
  mercado pouco líquido/ruidoso não dominar a previsão. Direcionalmente
  correto, não uma réplica exata do mercado.
- O emparelhamento de nomes de equipas entre a FPL e a The Odds API é por
  correspondência exata (com uma tabela de aliases conhecidos), nunca por
  aproximação — se uma equipa não corresponder por algum motivo (ex.: um
  nome mudou), essa equipa simplesmente fica sem o ajuste de mercado nessa
  jornada, em vez de arriscar aplicar o sinal errado a outra equipa.
- Os multiplicadores da pontuação por clean sheets/golos esperados foram
  recalibrados para a janela por omissão de 5 jornadas (ver comentários em
  `lib/recommend.ts`) — se algum dia mudares o tamanho dessa janela, vale a
  pena rever esses números, porque deixam de estar calibrados para o total
  esperado numa janela de outro tamanho.
