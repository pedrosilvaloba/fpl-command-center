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
  api/insights/route.ts       Lê/escreve notas táticas dinâmicas (GET aberto; POST/DELETE autenticados por INSIGHTS_API_TOKEN)
  api/insights/push/route.ts  Escrita em forma de GET — a única via que a sessão de investigação agendada consegue alcançar (ver lib/insightsintake.ts)
  api/backtest/route.ts       Corre o backtest do modelo contra jornadas já jogadas (autenticado; ?cached=1 lê o último resultado)
lib/
  types.ts        Tipos TypeScript para as respostas da API da FPL
  fpl-client.ts   Cliente HTTP server-side para a API da FPL (com cache)
  fdr.ts          Construção do fixture ticker / dificuldade de calendário
  recommend.ts    Motor de pontuação, onze ideal, capitão e heurística de recurso
  matchmodel.ts   Modelo de golos esperados por equipa/jogo (Poisson) e clean sheets
  oddsapi.ts      Cliente da The Odds API — probabilidades de mercado (opcional)
  schedule.ts     Deteção de jornadas duplas e em branco por equipa
  playerthreat.ts Ameaça de golo/assistência individual, fiabilidade de utilização (incl. padrão de substituição cedo), bolas paradas, contribuição defensiva
  oddsmodel.ts    Inverte odds em golos esperados e deriva forças de equipa a partir do mercado
  correlation.ts  Risco de correlação — variância de empilhar jogadores do mesmo clube
  rankvalue.ts    Valor de ranking — desconta a posse, porque a FPL é um jogo de ranking
  squadstate.ts   Estado real da equipa — plantel atual, preços de VENDA estimados, saldo, transferências livres reconstruídas do histórico, chips
  transferplan.ts Planeamento de transferências — ILP sobre manter/vender/comprar, com o -4 no objetivo, e o sinal de Wildcard
  gwreview.ts     Revisão da jornada — previsão guardada antes do deadline vs. pontos reais, jogador a jogador
  insightsintake.ts Validação partilhada pelas duas vias de escrita das notas táticas
  rivals.ts       CAMADA 2 — simulação Monte Carlo contra os plantéis reais dos rivais da liga; produz a postura de variância (beta) que o otimizador usa
  strategylearning.ts CAMADA 3 — calibração aprendida por posição (previsto vs. real) e torneio de cinco estratégias de ranking avaliadas semanalmente
  expectedpoints.ts Modelo de pontos esperados — minutos, golos, assistências, clean sheets, bónus, contribuição defensiva
  managerinsights.ts Ajustes qualitativos/táticos — lista permanente manual + camada dinâmica auto-aplicada (resolução de nomes, validação, expiração, limite)
  teamrating.ts   Rating de equipa dinâmico (Elo + taxa de golos), calibrado com os resultados reais desta época
  accuracy.ts     Compara previsões do modelo com pontos reais, jornada a jornada (opcional, precisa de Redis)
  backtest.ts     Backtesting — reconstrói o estado do mundo em cada deadline passado e volta a correr o modelo real contra o que aconteceu
  optimizer.ts    Otimizador real (programação linear) da equipa sugerida
  pricewatch.ts   Preditor de mudanças de preço e monitor de notícias/lesões
  strategy.ts     Playbook e regras 2026/27 (conteúdo da investigação)
  constants.ts    Team ID e League ID por omissão desta instalação pessoal
  kv.ts           Cliente Upstash Redis (com fallback gracioso se não ligado)
tests/
  fixtures.ts        Dados sintéticos partilhados + micro-harness de asserções
  regression.test.ts Suite de regressão — um teste por defeito encontrado na auditoria
components/
  CountdownTimer.tsx  Contagem decrescente até ao deadline (client)
  FixtureTicker.tsx   Calendário — cartões em telemóvel, tabela em ecrã grande
  PlayerTable.tsx     Lista reutilizável de jogadores — cartões em telemóvel, tabela em ecrã grande
  PitchView.tsx       O onze desenhado no relvado, ao estilo da FPL, com banco e distintivos
  ClubKit.tsx         Camisola de cada clube em SVG (a API da FPL não publica cores)
  TransferPlanPanel.tsx O que fazer antes do deadline — planos ordenados, horizontes, e as limitações declaradas
  GameweekReviewPanel.tsx Como correu a minha equipa — previsto vs. real, capitão, banco
  LeagueSimPanel.tsx  Camada 2 — postura, probabilidades por rival e sobreposição de plantéis
  StrategyPanel.tsx   Camada 3 — torneio de estratégias e calibração aprendida
  MyTeamPanel.tsx     A Minha Equipa — liga um Team ID real (client)
  ShadowTeamPanel.tsx Shadow Team — simulador de plantel (client, Redis + localStorage)
```

## Novo na v1.28 — auditoria externa ao modelo

Um especialista externo avaliou o modelo do princípio ao fim, sem o ter visto
antes. Encontrou catorze defeitos. Estão todos corrigidos, com um teste de
regressão por cada um — e, mais importante, a recomendação estrutural que a
auditoria disse valer mais do que os dez defeitos individuais também está
feita.

### O que estava mal na aritmética de cada jogador

- **A desigualdade de Jensen, em três sítios.** A tabela de pontuação da FPL
  é cheia de degraus: -1 por cada 2 golos sofridos, 1 por cada 3 defesas,
  2 pontos ao chegar a 10 ações defensivas. O modelo dividia a MÉDIA pelo
  degrau, quando o que se paga é a média DO degrau — coisas diferentes.
  Com 1.35 golos esperados sofridos, a forma antiga cobrava 0.68 onde a
  verdade são 0.44: um imposto fixo sobre guarda-redes e defesas que nenhum
  médio ou avançado pagava. As defesas do guarda-redes tinham o erro ao
  contrário, a oferecer 0.33 pontos por jogo a todos os guarda-redes. Ambos
  passam a usar a forma exata `E[floor(X/d)] = Σ P(X ≥ jd)`.
- **A contribuição defensiva era uma reta onde tem de ser uma curva em S.**
  Com 5 ações por 90 minutos o modelo dizia 25% de probabilidade quando a
  verdade são 3%; com 15 dizia 75% quando são 93%. Errado nos dois sentidos
  ao mesmo tempo, o que estragava exatamente a alavanca dos defesas baratos
  que esta regra criou. E deixa de exigir 60 minutos: o bónus paga-se pelas
  ações, não pelo tempo.
- **Os penáltis contavam duas vezes.** O xG de um jogador já inclui os
  penáltis que marca; somar por cima a taxa de bolas paradas inflacionava
  precisamente os avançados premium que são candidatos a capitão, onde o
  erro custa a dobrar.
- **Os cartões não contavam de todo.** A taxa de amarelos é das mais estáveis
  que existem, e a omissão não era neutra: caía sobre os centrais e médios
  defensivos com 0.25-0.40 amarelos por 90 — o mesmo arquétipo que o bónus
  defensivo recompensa. O modelo pagava-lhes para desarmar e nunca lhes
  cobrava os cartões que desarmar produz.
- **Encolhimento por tamanho de amostra.** Com 90 minutos jogados, um jogo
  de 60 BPS implicava uma taxa de 60, e um amarelo implicava um cartão por
  jogo. Cada taxa passa a ser puxada para um valor neutro pela sua própria
  amostra, com prior mais pesado nas estatísticas que se realizam raramente.
- **As defesas do guarda-redes eram comparadas com uma constante da liga**
  em vez do nível normal da própria equipa — o mesmo erro de contar a
  qualidade da equipa duas vezes que o lado atacante já tinha corrigido e
  este lado não.

### O que estava mal no modelo de jogo

- **Os limites do rating de equipa eram estreitos demais** (0.8 a 1.25). Um
  Liverpool em casa contra um promovido não cabe nesse intervalo; o modelo
  achatava os extremos, que é onde estão as decisões. Passam a 0.5 a 1.6.
- **As bases da liga estavam desatualizadas** (1.5 e 1.2 golos, total de
  2.70). A Premier League atual anda nos 2.95-3.28. E agora nem são
  constantes: medem-se nos resultados desta época assim que houver amostra.
- **A escolha da fonte era uma escada de "ou isto ou aquilo".** Um jogo com
  odds descartava por completo o que os resultados e os ratings diziam.
  Passa a haver uma mistura ponderada pela precisão de cada fonte, em espaço
  logarítmico.
- **A linha de golos do mercado estava fixa em 2.5.** As casas movem a linha
  para 3.5 nos jogos com muitos golos e 2.5 nos fechados — ler a linha errada
  é ler o preço errado. Passa a aceitar qualquer linha e a escolher a modal
  entre casas.
- **A janela de 5 jornadas era uma média plana.** Tratava a jornada n+4 como
  a n, misturando um número afinado pelo mercado com quatro estimativas
  desfocadas. Passa a ponderar por horizonte e por precisão da fonte.
- **O descanso entre jogos não existia no modelo.** `kickoff_time` estava no
  tipo e não era lido por ninguém — é o único dado preciso para o segundo
  jogo de uma jornada dupla e para o sábado a seguir à quarta-feira europeia.

### O que estava mal na camada de decisão

- **A regra do -4 estava a comparar com a coisa errada.** A alternativa a
  pagar -4 não é "nunca transferir", é "transferir de graça para a semana" —
  por isso um hit compra exatamente UMA jornada, e tinha de render mais de 4
  pontos nessa jornada. A regra antiga disparava a partir de 0.8 pontos por
  jornada.
- **Uma transferência livre vale ~1.5 pontos guardada.** Gastar a última não
  é gratuito e o planeador tratava-a como se fosse.
- **A ordenação dos planos usava um objetivo diferente do do otimizador** —
  o mesmo desencontro que já tinha sido corrigido uma vez e voltou a entrar.
  Agora existe uma função única, usada nos dois sítios.
- **A braçadeira eram duas listas em vez de um par.** O vice é dobrado
  exatamente quando o capitão não joga, o que tem uma consequência
  contra-intuitiva: um premium em dúvida NÃO deve ser penalizado outra vez
  pela dúvida na escolha do capitão, porque o vice devolve a duplicação nos
  casos em que a dúvida se confirma. Ordenar só por pontos esperados conta a
  dúvida duas vezes.
- **O banco não tinha ordem nenhuma.** As substituições automáticas seguem a
  ordem do banco e disparam quase uma vez por jornada; o banco era o resto
  de um filtro, na ordem em que o solver calhasse. Passa a ser guarda-redes
  suplente à parte e os três de campo por P(jogar) × pontos.
- **O otimizador devolvia plantéis acima do orçamento a dizer que estavam
  bem.** Confirmado em produção: £106.7m com o limite em £100m. O conjunto
  de candidatos passa a ser mais pequeno e melhor estruturado, e há
  validação independente com nova tentativa em vez de confiança no solver.

### A recomendação que valia mais do que as dez — backtesting

Todos os números deste projeto eram justificados por um argumento. Os
argumentos são baratos. Uma mistura de 0.65/0.35, um prior de 3 jogos, um
decaimento de 4 jornadas — cada um foi escolhido por soar bem, e nenhum
tinha alguma vez sido confrontado com um resultado. Sem isso não há como
distinguir uma melhoria de uma regressão bem argumentada, e cada alteração
futura ao modelo é um palpite.

`lib/backtest.ts` reconstrói o mundo tal como estava no deadline de cada
jornada passada — somando o histórico jogo a jogo que a FPL publica por
jogador — e volta a correr o **pipeline real** (`buildScoredPlayers`, não uma
cópia) contra o que aconteceu de facto. Reutilizar o código que está em
produção é o ponto todo: um backtest que reimplementa o modelo testa a
reimplementação.

O que mede: erro médio, viés, correlação de ordem (que é o que interessa —
escolher jogadores é um problema de ordenação, e um modelo pode ser
otimista em dois pontos e ordenar na perfeição), a diferença entre o decil
de topo e o de fundo, com que frequência o jogador nº1 do modelo acabou no
top 10 real da jornada, calibração por escalão — e sempre, ao lado, o que
uma previsão ingénua (a média de pontos por jogo de cada um) teria feito.
Um erro de 1.8 pontos pode ser excelente ou vergonhoso conforme o que a
resposta trivial consegue.

As limitações vão escritas dentro do próprio resultado, não numa nota de
rodapé: os estados de lesão de hoje não são reconstituíveis e foram
neutralizados (por isso o backtest mede o modelo SEM a camada de
disponibilidade, e não recebe crédito por ela); a estimativa da própria FPL
não fica arquivada e foi substituída pela média de pontos por jogo; e as
notas táticas manuais não são aplicadas, porque são escritas com o
conhecimento de hoje.

Quatro dos testes novos existem só para atacar a fuga de informação, que é
o único erro que invalida um backtest por completo: adulterar as jornadas
futuras não pode mexer numa única previsão, e adulterar os resultados da
própria jornada testada tem de piorar as métricas — se não piorar, o modelo
estava a copiar em vez de prever.

Corre a partir da app (`/api/backtest`), não daqui: o ambiente onde este
projeto é desenvolvido chega à internet por um proxy que recusa
`fantasy.premierleague.com`, por isso o histórico por jogador só pode ser
obtido de dentro do deploy.

## Novo na v1.27.1

Duas correções encontradas ao verificar a v1.27 já em produção:

- **O wildcard estava a ser recomendado na jornada 2.** O sinal media a
  distância ao plantel ideal e o que essa distância vale em pontos, e disparava
  acima de 5 transferências e 12 pontos — sem olhar para o calendário. Faltavam
  duas coisas que só pesam cedo na época: a essa altura o "ideal" assenta quase
  todo em estimativas de pré-época e em poucas odds, por isso a distância mede
  sobretudo ruído; e um chip guardado vale mais do que os pontos que compraria
  hoje, porque só há dois por época e a informação melhora todas as semanas. A
  barra de pontos passa a decair com a jornada: ~32 pontos na jornada 2, 12 a
  partir da jornada 10. Uma diferença esmagadora continua a justificar o chip
  em qualquer altura — a regra não é "nunca cedo".
- **A frase da decisão partia-se com muitas transferências.** Foi escrita a
  pensar em uma ou duas trocas; num plano de wildcard, cinco nomes e cinco setas
  transbordavam a linha e deixavam de ser uma instrução. Acima de duas trocas
  passa a resumir ("Joga o Wildcard — 6 transferências") e a lista detalhada
  fica no painel.

## Novo na v1.27 — redesenho

O feedback foi que a interface ocupava muito espaço com pouco conteúdo, que
as quatro caixas de estatísticas no topo não pareciam relevantes, e que a
tipografia podia ser mais moderna. Todas as três críticas estavam certas, e
duas delas apontavam para o mesmo problema de fundo.

**O topo comia um terço do ecrã sem responder a nada.** O cabeçalho tinha
370px de altura — dos quais 150px eram quatro caixas com bordas a reportar
estado interno do modelo (um coeficiente de variância a 0.00, um desvio-padrão,
uma etiqueta "predefinição"). A seguir vinha um alerta a ocupar a largura toda
e um título de secção com mais 150px. Num portátil, mais de metade do primeiro
ecrã passava sem uma única informação acionável.

- A barra de topo passou a **uma linha** (~90px com a navegação): jornada à
  esquerda, relógio do deadline à direita. O relógio é o único número
  relevante em todas as visitas, por isso ganhou tipo de display e a cor da
  marca, e fica vermelho nas últimas 24 horas.
- As quatro caixas desapareceram. No lugar delas há **um cartão de decisão**
  logo no início do conteúdo, que diz a jogada em texto grande e a qualifica
  com pares `etiqueta: valor` em linha — sem bordas, sem grelha.
- Os alertas passaram a **tiras de uma linha** com uma barra de cor lateral, e
  mudaram-se para **depois** da decisão. Um aviso de "dois jogos ainda sem
  odds" tinha o mesmo peso visual que o plantel; é assim que se ensina alguém
  a ignorar avisos.
- Quando ainda não há plantel publicado, a secção principal deixou de mostrar
  um pedido de desculpas e passa a **desenhar o onze** que o modelo escolheria.

**Tipografia.** Space Grotesk para display, Inter para texto, DM Mono para
números. O conjunto anterior (Archivo + Barlow + JetBrains Mono) era competente
e completamente anónimo, e o JetBrains Mono é uma fonte de *código* — usá-la em
todos os preços e pontuações fazia a app parecer uma ferramenta de programador
em vez de um produto de desporto.

**Cor.** O corpo da página deixou de ser tingido de roxo. Um cabeçalho roxo
sobre um fundo roxo-acinzentado lê-se como uma só mancha e a cor da marca deixa
de significar seja o que for. Com o fundo neutro, o roxo e o verde voltam a
registar-se.

**Densidade.** Títulos de secção um degrau mais pequenos, cartões mais
compactos, o relvado limitado a 620px e centrado (um 3-4-3 esticado por 1200px
lê-se como um campo vazio com um ajuntamento no meio), e a duplicação removida —
a jogada recomendada aparecia três vezes no mesmo ecrã.

## Novo na v1.26.1

Duas correções encontradas ao verificar a app em produção:

- **A janela cega do planeador.** O estado do plantel estava condicionado a
  `finished` — a marca que a FPL só põe depois de confirmar bónus e estatísticas
  finais, dias depois do último apito. Mas os plantéis passam a ser públicos
  assim que um **deadline** passa. O resultado é que o planeador de
  transferências ficava às escuras de sexta à noite até terça — exatamente a
  janela em que se planeiam transferências. Passou a usar o deadline, o que
  além de corrigir a janela dá informação melhor: durante uma jornada a decorrer
  devolve o plantel já com as transferências feitas esta semana.
- **O alarme falso do calendário.** O aviso vermelho "modelo de calendário sem
  dados" contava todos os jogos das 5 jornadas seguintes. No início da época
  isso dispara sempre, porque as casas de apostas só abrem mercados uma ou duas
  semanas antes. Agora só é vermelho se a falha for na **próxima** jornada — a
  que interessa para escolher equipa; as jornadas mais distantes ficam numa nota
  informativa que explica que se preenche sozinha.

## Novo na v1.26

### 1. A app deixou de sugerir equipas impossíveis

Até aqui a "Equipa Sugerida" montava os 15 melhores jogadores para £100.0m,
do zero, todas as jornadas. É a resposta a uma pergunta que ninguém a meio de
uma época pode executar: só se pode fazer uma transferência por semana (duas
por -4), a partir do plantel que já se tem, com o dinheiro que se tem — que
não é £100m, é o valor do plantel mais o saldo.

- **`lib/squadstate.ts`** reconstrói o estado real: plantel atual, saldo,
  valor, **preços de venda** por jogador, **quantas transferências livres**
  existem (deduzidas do histórico público — `event_transfers_cost / 4` diz
  exatamente quantas foram pagas, logo quantas livres foram gastas) e que
  chips ainda estão por usar.
- **`lib/transferplan.ts`** resolve o problema certo: dado ESTE plantel,
  ESTE saldo e ESTAS transferências livres, o que fazer antes do deadline.
  Produz quatro planos — não fazer nada, usar as livres, aceitar um hit,
  jogar o Wildcard — ordenados pelos pontos esperados do onze **ao longo de 5
  jornadas menos o custo do hit**. O horizonte de 5 jornadas é deliberado: um
  -4 é um custo único pago contra um benefício que se repete.
- **"Não fazer nada" concorre em pé de igualdade** e ganha muitas vezes.
  Guardar transferências é das jogadas mais subvalorizadas da FPL.
- **Sinal de Wildcard**: a distância entre o plantel atual e o ideal, medida
  em transferências e em pontos. É o que dá sentido ao painel do plantel
  ideal, que passou a ser explicitamente um alvo e não um plano.

### 2. Revisão da jornada

`lib/gwreview.ts` guarda as previsões de todos os jogadores **antes** do
deadline e compara-as depois com os pontos reais do plantel efetivamente
alinhado: quem superou, quem falhou, quanto custou a braçadeira, quanto ficou
no banco, e como correu face à média da jornada. Guardar antes é obrigatório —
reconstruir "o que o modelo teria dito" depois do facto é um teste que o
modelo passa sempre.

### 3. As notas táticas nunca tinham chegado à app — e agora sabe-se porquê

A tarefa agendada disparava a horas todas as semanas e o painel continuava
vazio. A causa, confirmada por teste direto: **o sandbox onde a investigação
corre encaminha o tráfego de saída por um proxy com lista branca, e
`*.vercel.app` não está nela** — qualquer `curl` devolve 403 no túnel CONNECT
antes sequer de fazer o pedido. O desenho original ("a sessão faz POST para a
app") nunca podia ter funcionado, em nenhuma semana. E como reportar a falha
exigia a mesma ligação bloqueada, cada execução morria em silêncio.

- **`app/api/insights/push/route.ts`** é uma via de escrita em forma de GET,
  que é a única que a ferramenta de fetch dessas sessões consegue usar. Um GET
  que escreve é normalmente um erro; o porquê de ser aceitável aqui, e o que
  custa, está escrito por extenso em `lib/insightsintake.ts`.
- As notas ganharam **âmbito por jornada** (`events`) e **nível de confiança**
  (`confidence`). Sem o primeiro, uma notícia de uma semana só podia ser
  aplicada às cinco, exagerando-a cinco vezes. Sem o segundo, uma declaração
  do próprio treinador e a especulação de um comentador mexiam no modelo
  exatamente o mesmo.
- Passaram a existir **duas passagens semanais**: quinta-feira para a análise
  tática de fundo, e sexta-feira para as notícias de equipa — que é quando
  chegam as conferências de imprensa e os boletins clínicos, a informação mais
  valiosa da semana e a que chegava sempre tarde demais.

## Novo na v1.25

- **Camada 2 — simulação contra os rivais reais da liga (`lib/rivals.ts`).**
  A app deixa de otimizar em abstrato. Vai buscar o plantel público de cada
  gestor da Haal of Fame pelo Team ID e corre 4000 jornadas simuladas **ao
  nível do jogador**: em cada simulação sorteia-se um resultado por jogador
  (um clean sheet por clube, um número de golos por avançado, um resultado de
  bónus) e só depois se soma o onze de cada gestor sobre esses mesmos
  sorteios. Sortear por jogador e não por gestor é o ponto todo — faz com que
  dois gestores que partilham o Haaland subam e desçam juntos automaticamente,
  que é a correlação que decide ligas privadas.

  Daí sai uma probabilidade de acabar à frente de cada rival e, dessa, um
  único número — `beta` — que entra **diretamente no objetivo do otimizador**:
  `pontos esperados × (1 − beta × posse)`. Beta positivo desconta jogadores
  muito possuídos (perseguir: precisas de divergir); beta negativo prefere-os
  (proteger: uma vantagem sobrevive melhor quando te moves com o pelotão);
  beta zero é pontos esperados puros. O gerador de números aleatórios é
  semeado pela jornada, por isso os números não mudam a cada refresh.

- **Camada 3 — aprendizagem entre estratégias (`lib/strategylearning.ts`).**
  Duas coisas diferentes, deliberadamente não misturadas. **Calibração:**
  compara, por posição, o que o motor previu com os pontos reais, e corrige as
  previsões futuras dessa posição — encolhido por tamanho de amostra e travado
  a ±25%. **Torneio:** cinco formas de escolher jogadores (modelo puro,
  template, diferencial, só calendário, só forma) correm em paralelo todas as
  semanas, cada uma a montar a mesma forma de equipa (1-3-4-2) para que a
  comparação seja entre estratégias e não entre posições. Quando há evidência
  suficiente (≥4 jornadas), a vencedora inclina o `beta` da Camada 2 em no
  máximo ±0.15 — uma correção sobre a situação da liga, nunca um substituto.

  As previsões guardadas para medição são as do modelo **não calibrado**, de
  propósito: medir a calibração contra previsões já calibradas mediria a
  própria correção, convergiria para "sem viés" e desfazia-se sozinha.

- **Remodelação gráfica completa.** Paleta da Premier League (roxo #37003C,
  verde #00FF87, ciano #04F5FF, magenta #E90052), tipografia mais próxima da
  PremierSans, cabeçalho fixo com a régua de três cores da PL e uma faixa de
  decisão com os quatro números que interessam antes de mais nada. O onze
  passou a ser desenhado **no relvado** em vez de duas tabelas de nomes. Todas
  as tabelas passam a cartões abaixo dos 640px — a app deixou de ter scroll
  horizontal em telemóvel, e o `viewport` em falta (que fazia o Safari móvel
  renderizar a 980px e encolher) foi corrigido.

## O que já funciona (v1.24)

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
- **Revisão crítica do motor de pontuação (v1.8) — sete melhorias
  diretas.** Depois de reparar que uma equipa genuinamente candidata ao
  título só tinha UM jogador a aparecer nas recomendações, fizemos uma
  revisão a sério de onde o modelo era estruturalmente fraco. A causa:
  todos os médios/avançados da mesma equipa recebiam exatamente o mesmo
  número de "golos esperados da equipa" — o modelo não sabia distinguir,
  dentro de uma equipa, quem realmente marca golos. Sete correções
  diretas a isso e a outras lacunas identificadas:
  1. **Ameaça de golo/assistência individual** — cada jogador atacante
     (e defesas ofensivos) passa a ter a sua própria estimativa de golos
     + assistências esperados, a partir dos dados de xG/xA por jogador
     que a FPL já publica (e que a app já ia buscar, mas nunca usava),
     combinados com os retornos reais já obtidos. Ver `lib/playerthreat.ts`.
  2. **Fiabilidade de utilização (risco de rotação)** — um jogador que
     joga sempre 90 minutos e um suplente rotativo com boas médias
     deixam de ser tratados da mesma forma; a fiabilidade vem de quantos
     jogos da equipa este jogador realmente começou como titular.
  3. **Responsabilidades de bolas paradas** — marcadores de grandes
     penalidades, cantos e livres diretos (dados que a FPL também já
     publica) passam a valer mais na pontuação, refletindo o seu valor
     real em pontos FPL.
  4. **Menos dependência da "forma" da FPL** — a forma oficial (média de
     30 dias) mistura minutos, variância de bónus e dificuldade de
     calendário já defrontada; o seu peso na fórmula foi reduzido a favor
     do sinal individual mais fundamentado do ponto 1.
  5. **Rating de equipa dinâmico** — as classificações de força da FPL
     são um número interno, opaco e pouco atualizado. Um modelo próprio
     (estilo Elo + taxa de golos marcados/sofridos) recalcula, a partir
     dos resultados reais desta época, o quanto cada equipa está a jogar
     acima ou abaixo do que a FPL assume — e corrige o modelo de golos
     esperados com isso. No início da época (sem jogos ainda) isto não
     tem qualquer efeito — só começa a corrigir à medida que há resultados
     reais para aprender com eles. Ver `lib/teamrating.ts`.
  6. **Perfil de risco/recompensa (teto vs. chão)** — dois jogadores com a
     mesma pontuação esperada podem ter perfis de risco muito diferentes;
     jogadores com um teto bem mais alto que o chão recebem agora uma
     nota a assinalar isso, útil para decisões de capitão/diferenciais.
  7. **Painel de Precisão do Modelo** — a única forma séria de saber se
     tudo isto está mesmo a ajudar: a app guarda as suas próprias
     escolhas antes de cada jornada fechar e compara-as com os pontos
     reais assim que a jornada termina. Só consegue começar a medir a
     partir de agora (não há forma fiável de reconstruir previsões de
     jornadas já passadas) — ver secção dedicada na app e `lib/accuracy.ts`.
- **Correção de calibração (v1.9) — a Equipa Sugerida continuava igual.**
  Depois de ligar a v1.8, reparou-se (com razão) que a Equipa Sugerida não
  tinha mudado, apesar da ameaça de golo individual do ponto 1 acima
  existir e estar correta. A causa, confirmada a fazer as contas: o peso
  dado a essa nova ameaça individual na fórmula de pontuação
  (`ATTACK_MULTIPLIER = 0.5`) era cerca de 8x mais pequeno do que devia
  ser comparado com a "forma" e os "pontos por jogo" já existentes na
  mesma fórmula — o sinal novo estava correto, mas era pequeno demais
  para alguma vez virar uma ordenação. Pior: início de época, "forma" e
  "pontos por jogo" são eles próprios dominados por quem já teve uma
  grande exibição cedo — exatamente a mesma dinâmica que o sinal novo
  devia estar a corrigir. Duas correções diretas:
  - O peso do sinal de ameaça individual foi multiplicado por 6x
    (`ATTACK_MULTIPLIER` de 0.5 para 3.0), para deixar de ser irrelevante
    ao lado de forma/pontos por jogo.
  - A "forma" da FPL passa a pesar menos quanto menor for a amostra de
    minutos do jogador esta época (40% do peso a 0 minutos, sobe até
    100% por volta de 3 jogos completos) — o mesmo princípio de "não
    confiar demasiado numa amostra pequena" que `lib/teamrating.ts` já
    aplicava ao nível da equipa, agora também ao nível do jogador.
    Jogadores com amostra ainda pequena recebem uma nota a dizê-lo.
  Ver os comentários junto a `ATTACK_MULTIPLIER` em `lib/recommend.ts`
  para as contas completas por trás desta correção.
- **Revisão a sério (v1.10) — três coisas verificadas ao vivo contra a
  API real, não assumidas.** Depois de v1.9, continuava tudo igual — com
  razão a insistir para se confirmar mesmo o que se passava. Desta vez
  fez-se uma verificação direta contra a API real da FPL (não assumida a
  partir de documentação) para três perguntas concretas:
  1. **Os nomes dos campos de xG/xA estão certos?** Confirmado ao vivo:
     sim, todos os 12 campos usados por `lib/playerthreat.ts` (incluindo
     `expected_goal_involvements_per_90`, `starts`, `penalties_order`)
     existem exatamente como assumido — não era um problema de nomes de
     campos errados.
  2. **Porque é que a nota "ameaça de golo" nunca aparece e a Equipa
     Sugerida não muda um único jogador, mesmo depois da correção de
     calibração?** A causa real, também confirmada ao vivo: **a época
     2026/27 ainda não começou** — o deadline da Jornada 1 é hoje,
     2026-08-21, ainda a horas de distância no momento desta verificação.
     Nenhum jogador tem minutos, golos, assistências ou golos esperados
     reais esta época (estão todos a zero, sem exceção) — não porque o
     código esteja errado, mas porque literalmente ainda não se jogou
     nenhum jogo. Toda a diferenciação individual (ponto 1 da v1.8, a
     correção de peso da v1.9) está corretamente desativada em pré-época
     por desenho — e vai ativar-se sozinha assim que a Jornada 1
     terminar, sem precisar de mais nenhuma alteração. Isto não é um
     "seria bom ter mais dados" — é uma impossibilidade genuína: não há
     forma de nenhum modelo saber hoje qual jogador do Arsenal vai
     render mais esta época sem ter visto um único jogo. Dito isto, havia
     uma coisa real a melhorar: a FPL publica o seu próprio campo
     `ep_next` ("pontos esperados na próxima jornada"), calculado pela
     própria FPL e disponível mesmo antes de a época começar (ao
     contrário de forma/golos esperados, que precisam de jogos reais) —
     nunca tinha sido usado. Passa agora a ser o critério principal para
     diferenciar jogadores da mesma equipa em pré-época, com peso
     elevado precisamente por ser o único sinal individual genuíno
     disponível agora. Ver `epNext` em `lib/recommend.ts`.
  3. **O Calendário continua preso ao dígito 1-5 da FPL, apesar de toda
     a integração de odds/modelo de golos esperados?** Sim, isso era um
     bug de programação real, não de modelo — a secção "Calendário" tinha
     ficado ligada a `lib/fdr.ts` (o dígito antigo da FPL) desde o início
     do projeto, nunca foi atualizada para usar o modelo de golos
     esperados construído mais tarde. Corrigido: agora mostra os números
     reais do próprio modelo (ataque = golos esperados/jogo, defesa =
     probabilidade de clean sheet, separados em vez de misturados num só
     número, e assinalados quando ajustados por odds de mercado) — o que
     se vê nesta secção é agora exatamente o que alimenta a pontuação,
     não um número FPL paralelo e desatualizado. Ver `buildModelTicker`
     em `lib/matchmodel.ts`.
- **Camada qualitativa/tática — o objetivo original do projeto (v1.11).**
  A v1.10 corrigiu o que era mensurável a partir de dados (API da FPL +
  odds). Mas há um tipo de sinal que nenhuma API dá: padrões de gestão
  (ex: "o Arteta tira sempre o Rice aos 55min em jogos ganhos") e
  identidade tática de equipa (ex: "o Man United sofre muito mas também
  marca muito este ano"). Isto exige mesmo investigação — ler relatórios
  de jogo, análise tática, notícias — não só processar números. Três
  peças novas para isto:
  1. **Correção concreta e imediata inspirada pelo exemplo do Rice** —
     `lib/playerthreat.ts` só olhava para "quantos jogos começa" (`starts`),
     nunca para "quanto tempo fica em campo quando começa". Um jogador
     pode ser titular todas as semanas e ainda ser um ativo fraco em FPL
     se for substituído sistematicamente antes dos 60min (o limiar da FPL
     para os pontos de presença completos e para o bónus de contribuição
     defensiva). Agora calcula-se `minutos/starts` como aproximação da
     média de minutos por jogo como titular e, com pelo menos 3 titularidades
     (para não reagir a uma substituição pontual), penaliza-se a fiabilidade
     do jogador proporcionalmente — com nota explicativa própria. Isto é
     inteiramente calculado a partir de dados que a app já tinha, sem
     integração nova nenhuma. Ver `EARLY_SUB_MINUTES_THRESHOLD` em
     `lib/playerthreat.ts`.
  2. **`lib/managerinsights.ts` — duas camadas, uma automática.** Uma
     lista permanente e escrita à mão (`MANAGER_INSIGHTS`, começa vazia)
     para padrões confiantes o suficiente para entrar no código a sério, e
     uma camada **dinâmica, aplicada automaticamente**, alimentada pela
     investigação semanal abaixo — decisão explícita do Pedro: isto não
     fica à espera dele para ter efeito. Cada entrada tem jogador/equipa,
     um fator de ajuste modesto (0.8-1.2, sempre — reforçado no código,
     não só documentado), a razão e a fonte, e alimenta diretamente a
     lista de razões de cada jogador na Equipa Sugerida, tal como qualquer
     outro sinal do modelo — automático não é o mesmo que invisível.
  3. **Investigação semanal agendada, com aplicação automática e
     proteções** — uma tarefa agendada (fora desta conversa, quintas de
     manhã) pesquisa na web padrões de substituição e identidade tática, e
     publica os achados diretamente via `POST /api/insights`, sem
     aprovação manual prévia. Porque isto ajusta a pontuação de todos sem
     revisão antes de entrar em vigor, tem proteções reais, não apenas
     documentadas:
     - **Validação de nomes por código, nunca por IA a ler o JSON** — a
       investigação envia nomes de jogador/equipa (o que encontra a
       pesquisar), e `resolveInsightTarget` em `lib/managerinsights.ts`
       resolve isso a um id real da FPL por correspondência determinística
       (com casos de teste para acentos, apelidos ambíguos como "Silva" e
       desambiguação por equipa) — o mesmo princípio de "não deixar um
       modelo pequeno interpretar JSON grande" que já regia o resto deste
       projeto, aplicado agora à escrita, não só à leitura.
     - **Fator sempre entre 0.8 e 1.2**, verificado no servidor.
     - **Expira ao fim de 2 semanas** (escolha explícita do Pedro) — uma
       nota errada ou desatualizada sai sozinha; a investigação seguinte
       tem de a reconfirmar para continuar a valer.
     - **Máximo de 15 notas dinâmicas em simultâneo** — nunca pode crescer
       a ponto de dominar o modelo quantitativo.
     - **Endpoint de escrita protegido** por `INSIGHTS_API_TOKEN` (ver
       "Deploy" abaixo) — só a tarefa agendada (ou o Pedro, manualmente)
       consegue escrever; qualquer visitante só consegue ler (`GET`).
     - **Painel "Notas Táticas Ativas"** no dashboard mostra exatamente o
       que está aplicado agora, com razão, fonte e validade — e um
       `DELETE /api/insights?key=...` autenticado permite ao Pedro matar
       uma nota específica antes da expiração natural, se alguma vez
       discordar de uma — a rede de segurança para "automático não é
       irreversível".
- **As odds passam a ser a fonte PRIMÁRIA da dificuldade (v1.14).** Até
  aqui a dificuldade de calendário vinha dos ratings `strength_*` da FPL, e
  as odds eram só uma correção por cima. Duas coisas tornam isso a ordem
  errada: os ratings da FPL são grosseiros, opacos e às vezes simplesmente
  não existem (confirmado ao vivo a 2026-08-21 — as 20 equipas com todos os
  campos a **0**, o que colapsava cada jogo para 0.00 golos esperados e
  100% de clean sheet); e a correção antiga era matematicamente incapaz de
  exprimir o que mais importa, porque escalava os dois números em sentidos
  opostos e deixava o **produto** inalterado — ou seja, dizia quem ganha e
  não dizia nada sobre quantos golos se marcam, que é precisamente o que
  determina os clean sheets. Agora existe uma hierarquia explícita, e cada
  jogo mostra de onde vieram os seus números (passa o rato por cima):
  1. **odds do próprio jogo** — as probabilidades do mercado são invertidas
     nos golos esperados que as reproduzem, usando o mercado de resultado
     (1X2) **e o de mais/menos 2.5 golos**, que passou a ser pedido. É isto
     que recupera o total, e não só o equilíbrio entre as equipas.
  2. **força derivada das odds** — os bookmakers raramente publicam linhas
     a cinco jornadas de distância, por isso as forças de cada equipa são
     estimadas a partir dos jogos que o mercado JÁ avaliou, e usadas para
     projetar os que ainda não tem. É assim que se deixa de depender da
     FPL mesmo para jogos distantes.
  3. **resultados desta época** — o Elo e as taxas de golos de
     `lib/teamrating.ts`, que estavam a ser calculados e nunca usados.
  4. **ratings da FPL** — só se existirem mesmo e não forem zero.
  5. **valor neutro** — e nesse caso a app **diz-te em letras vermelhas**
     que está sem dados, em vez de mostrar números que parecem reais.
- **Diagnóstico das odds (v1.14).** `getOddsStatus` deixou de devolver
  `null` para tudo. Distingue agora "chave não configurada", "chave
  rejeitada (401)", "quota esgotada (429)" e "sem jogos abertos", e mostra
  a razão exata no topo do dashboard. Isto existe porque a chave nunca
  esteve configurada em produção e nada o dizia — a fonte de dados mais
  valiosa da app esteve silenciosamente ausente enquanto o modelo de
  calendário funcionava sem informação nenhuma.
- **Reescrita do motor em pontos esperados (v1.12).** Uma auditoria
  independente concluiu que a pontuação anterior — uma soma ponderada com
  multiplicadores escolhidos à mão — tinha três problemas que nenhuma
  recalibração resolvia: não tinha unidade (médios pontuavam 22-64 e
  defesas 9-32 só porque os termos de ataque eram maiores, o que decidia
  por posição qualquer comparação entre posições, e tornava impossível
  avaliar um hit de -4); contava a forma recente cinco vezes através de
  `form`, `ppg`, `ep_next`, a metade realizada da ameaça individual e o
  índice ICT, somando ~60% da pontuação de um premium; e deixava de fora
  sinais reais por não haver onde os encaixar. `lib/expectedpoints.ts`
  modela agora cada mecanismo de pontuação da FPL pelos pontos que ele
  realmente paga, o que resolve os três de uma vez. Mudanças concretas:
  - **Modelo de minutos a sério** — separa "começa o jogo?" de "fica em
    campo até aos 60min?", que são riscos diferentes. A estimativa de
    minutos por titularidade está agora limitada a 90 (antes podia dar
    123min/jogo e anular a penalização por substituição cedo).
  - **Bónus entram na pontuação** — `bonus` era obtido da API e nunca
    usado, apesar de valer ~0,5-1,5 pts por jornada num premium e ser
    altamente previsível.
  - **Bolas paradas contam em pré-época** — ser o marcador de penáltis é
    um papel, não uma estatística acumulada, por isso é conhecido antes de
    a época começar. Era calculado e deitado fora exatamente nessa altura.
  - **Capitão e onze passam a usar a próxima jornada** — a braçadeira
    duplica os pontos de UMA jornada; era escolhida por um total de cinco.
  - **`ep_next` passa a ser parceiro de mistura, não mais uma parcela** —
    com poucos minutos jogados a estimativa da FPL é melhor informação que
    a nossa; ao fim de ~4 jogos o nosso modelo domina. Isto elimina a
    dupla contagem e, de caminho, a descontinuidade que fazia as
    pontuações saltar 3× no fecho da GW1.
  - **Contexto de calendário normalizado pela própria equipa** — o ritmo
    por 90min de um jogador foi obtido a jogar naquela equipa, por isso já
    contém a qualidade dela; comparar com a média da liga contava as
    equipas fortes duas vezes.
- **Correções da auditoria (v1.12).** Notas táticas passam a aparecer nas
  razões da Equipa Sugerida (antes só em Melhores Escolhas e Diferenciais,
  apesar de a app prometer o contrário); o limite de ±20% passa a ser
  aplicado ao **efeito combinado** das notas e não a cada uma
  isoladamente (três notas a 0.8 compunham para -49%); a inversão que
  classificava a melhor defesa da liga como exatamente média foi
  substituída por suavização de Laplace; a heurística de recurso passa a
  construir um plantel legal pelo preço mínimo antes de o melhorar, e o
  otimizador deixou de escrever `feasible: true` à mão sem validar; "A
  Minha Equipa" deixou de pedir à FPL a jornada que ela não serve; e o
  Painel de Precisão compara agora **dentro de cada posição** (antes
  juntava as quatro e media, na prática, a diferença entre médios e
  defesas — um modelo aleatório teria reportado o mesmo valor).
- **Suite de regressão (v1.12).** `npm test` corre 53 verificações, uma
  por defeito encontrado na auditoria. Até aqui as verificações eram
  escritas, corridas e apagadas antes de empacotar, o que significava que
  nada impedia uma correção futura de reintroduzir em silêncio um defeito
  já resolvido. `npm run verify` corre tipos, lint e testes de uma vez.
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
- Fixture ticker (próximas 5 jornadas) com golos esperados/clean sheet do
  próprio modelo (não o dígito 1-5 da FPL — ver ponto 3 da v1.10 acima).
- Diferenciais (jogadores com posse < 10%) e melhores escolhas por posição.
- Playbook de estratégia e cheat sheet de regras, com fontes citadas.

## Roadmap (próximas iterações)

1. **Planeamento a mais de uma jornada de distância.** O plano atual é ótimo
   para esta semana: escolhe a melhor jogada dado o que existe hoje. O que
   ainda não faz é raciocinar sobre o futuro do próprio plano — que guardar
   duas transferências permitiria, daqui a duas jornadas, uma jogada que hoje
   não é possível. É o mesmo salto que a Camada 2 deu na dimensão dos rivais,
   aplicado à dimensão do tempo.
2. **Valor esperado de cada chip.** A deteção de duplas/brancas já existe e o
   simulador da Camada 2 já produz distribuições, não só médias. Falta
   juntá-los: quanto vale, em pontos e em probabilidade de subir na liga,
   gastar o Bench Boost nesta dupla em vez de esperar pela próxima — e o mesmo
   para o Triple Captain e o Free Hit.
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
   - Ainda falta: construir isto de facto. As Camadas 2 e 3, que estavam à
     frente dele nesta lista, ficaram feitas na v1.25 — mas continua a ser o
     item de maior risco de todo o projeto (credenciais reais), por isso o
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

### Passo NECESSÁRIO: ligar o Upstash Redis

Deixou de ser opcional. Sem ele três funcionalidades não funcionam — e,
ate à v1.15, nenhuma delas o dizia: a Shadow Team ficava só no browser, o
Painel de Precisão não registava nada, e a investigação semanal fazia a
pesquisa toda e falhava silenciosamente na gravação das notas táticas. A
app passa a avisar em vermelho quando isto não está ligado.

Sem isto a Shadow Team continua a funcionar normalmente, só que guardada
apenas no browser onde a usaste, e o Painel de Precisão do Modelo fica
por ligar. Para sincronizar entre telemóvel/computador e ativar o painel:

1. No painel do projeto na Vercel, vai a **Storage** → **Create Database** →
   escolhe a integração **Upstash** (ou procura "Redis" no Marketplace) →
   plano gratuito.
2. A Vercel liga automaticamente as variáveis de ambiente necessárias ao
   projeto — não precisas de copiar nada à mão. Nota: a integração da
   Vercel injeta-as com o prefixo `KV_` (`KV_REST_API_URL`,
   `KV_REST_API_TOKEN`), herdado do antigo Vercel KV, enquanto as
   credenciais tiradas diretamente de upstash.com chamam-se
   `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`. `lib/kv.ts`
   aceita as duas convenções — até à v1.17 só reconhecia a segunda, o que
   fazia uma base de dados corretamente criada e ligada parecer
   desconfigurada.
3. No deploy seguinte, a Shadow Team passa a mostrar "Sincronizado entre
   dispositivos" em vez de "Guardado só neste browser", e a secção
   "Precisão do Modelo" começa a guardar as escolhas de cada jornada
   automaticamente (só a partir daí — não consegue reconstruir jornadas
   já passadas).

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

### Passo necessário para a investigação semanal automática (`INSIGHTS_API_TOKEN`)

Sem isto, a app continua a funcionar normalmente, e `GET /api/insights`
continua a ler notas dinâmicas já guardadas — mas nenhuma nota NOVA
consegue ser escrita (a tarefa agendada recebe 401 e a semana fica sem
efeito nenhum), porque o endpoint de escrita fica desligado por omissão em
vez de aceitar pedidos sem chave nenhuma.

1. Gera um valor aleatório longo para servir de chave (por exemplo,
   `openssl rand -hex 24` no terminal, ou qualquer gerador de password de
   pelo menos 32 caracteres).
2. No projeto na Vercel: **Settings** → **Environment Variables** →
   adiciona uma variável chamada `INSIGHTS_API_TOKEN` com esse valor →
   grava.
3. Faz um novo deploy para a variável ficar ativa.
4. O mesmo valor tem de estar configurado na tarefa agendada semanal
   ("FPL - Análise Semanal Tática e Padrões de Gestão", ver `/config` ou
   a lista de tarefas agendadas) para que os pedidos `POST` dela sejam
   aceites — já está configurado com o valor gerado nesta sessão; só
   precisas de repetir este passo se algum dia gerares uma chave nova.
5. Também precisa da mesma integração Upstash Redis do passo da Shadow
   Team acima — sem Redis, `GET /api/insights` funciona mas devolve
   sempre só a lista estática (vazia por omissão), e qualquer escrita
   falha mesmo com a chave certa.

## Notas honestas

- A API da FPL é pública mas **não-oficial e não documentada** pela
  Premier League — pode mudar sem aviso. O código foi escrito para falhar
  de forma controlada (erros claros) em vez de rebentar silenciosamente.
- O "Calendário" (Fixture Ticker) mostrou o dígito 1-5 oficial da FPL até
  à v1.9 por um esquecimento real de programação — nunca tinha sido
  atualizado para usar o modelo de golos esperados construído mais tarde
  no projeto. Corrigido na v1.10: mostra agora os números do próprio
  modelo de `lib/matchmodel.ts` (golos esperados + probabilidade de clean
  sheet, separados), corrigido pelo rating de equipa dinâmico de
  `lib/teamrating.ts` (Elo + taxa de golos, calibrado com os resultados
  reais desta época) e por odds de mercado quando disponíveis.
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
- Os campos de xG/xA individual, `starts` e ordem de bolas paradas
  (`lib/playerthreat.ts`) foram inicialmente adicionados a partir de
  documentação pública da comunidade open-source da FPL, e depois
  **confirmados numa consulta direta à API ao vivo em 2026-08-21** — os
  nomes dos campos estão certos. Cada leitura continua a ser feita de
  forma defensiva (campo em falta ou renomeado → contribui 0/nulo, nunca
  rebenta a página) como proteção para o resto da época, caso a FPL algum
  dia mude isto sem aviso — mas não é a explicação de nada que pareça
  "não estar a funcionar" agora. Antes da Jornada 1 terminar, os valores
  destes campos são legitimamente 0 para toda a gente (ninguém jogou
  ainda) — isso é o comportamento correto, não um sinal de bug.
- A "média de minutos por titularidade" (`lib/playerthreat.ts`,
  EARLY_SUB_MINUTES_THRESHOLD) é `minutos totais / starts` — uma
  aproximação, não o valor exato de "minutos só enquanto foi titular",
  porque a FPL não publica esse número separado dos minutos ganhos como
  suplente. Para um jogador cujas aparições são quase todas como titular
  (o caso comum) isto converge bem para a realidade; para um jogador com
  muitas entradas como suplente, pode sobrestimar ligeiramente a média.
  Só é aplicado com 3+ titularidades, precisamente para não reagir a
  ruído de amostra pequena.
- `lib/managerinsights.ts` começa **vazio** — nenhum padrão qualitativo
  foi inventado só para ter conteúdo. A lista permanente preenche-se ao
  longo do tempo por edição manual; a camada dinâmica preenche-se sozinha
  a partir da investigação semanal (ver secção v1.11 acima). Até à
  primeira pesquisa produzir algo válido, este mecanismo existe mas não
  altera nenhuma pontuação.
- A resolução de nomes (`resolveInsightTarget`) é uma correspondência
  determinística (exata, depois por substring, com equipa a desempatar),
  não um modelo de linguagem a adivinhar — mas continua a ser uma
  heurística: cobre bem os casos comuns (nome único, ou `web_name` da FPL
  já exato) e é testada para acentos e apelidos ambíguos conhecidos, mas
  um nome genuinamente novo e ambíguo sem `teamShortName` é rejeitado em
  vez de arriscar aplicar a nota ao jogador errado — rejeitar é sempre a
  opção mais segura aqui.
- O `DELETE /api/insights?key=...` (autenticado) é a forma de remover uma
  nota dinâmica antes da expiração natural de 2 semanas — não existe
  ainda um botão no dashboard para isto, só o endpoint; usar `curl` com o
  `INSIGHTS_API_TOKEN` é suficiente enquanto isto não justificar uma
  interface própria.
- Os multiplicadores novos (`ATTACK_MULTIPLIER`, `DEF_ATTACK_UPSIDE_MULTIPLIER`,
  `DC_WEIGHT` em `lib/recommend.ts`) são uma primeira calibração, não um
  ótimo validado — é exatamente para isto que serve o novo Painel de
  Precisão do Modelo: dar dados reais para rever estes números com o
  tempo, em vez de continuarmos a ajustá-los "a olho".
- O rating de equipa dinâmico (`lib/teamrating.ts`) não persiste estado —
  recalcula o histórico Elo/taxa-de-golos completo a partir dos fixtures
  já carregados em cada pedido. Isto é intencional (barato, sem risco de
  cache desatualizada), mas significa que depende inteiramente dos
  resultados que a própria API da FPL já reporta como terminados.
- O Painel de Precisão do Modelo só começa a medir a partir do momento em
  que é ativado — não existe forma fiável de reconstruir o que o modelo
  "teria dito" antes de jornadas já jogadas sem voltar a pedir o histórico
  jogo-a-jogo de cada um dos ~700 jogadores individualmente (uma operação
  pesada, não feita aqui). A comparação também assume que a primeira
  visita à app depois de uma jornada ficar "a seguir" acontece antes do
  deadline — o que é sempre verdade por construção (o deadline É o
  kickoff do primeiro jogo dessa jornada), mas se a app só for aberta
  vários dias depois de a jornada se tornar a próxima, a fotografia
  guardada pode já refletir pequenas variações de forma entretanto.
