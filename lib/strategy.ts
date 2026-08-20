// Distilled from research into official Premier League / FPL rule
// announcements for 2026/27, and into how elite managers (official PL
// champion interviews, AllAboutFPL's World #1 interviews, and
// FantasyFootballFix's Top-50 statistical series) actually played in
// recent seasons. Sources are noted inline; treat community-reconstructed
// numbers (marked as such) as directional, not official.

export interface PlaybookPrinciple {
  title: string;
  body: string;
  source: string;
}

export const PLAYBOOK: PlaybookPrinciple[] = [
  {
    title: "Quase zero hits, o ano todo",
    body: "O vencedor mundial de 2025/26 (Erik Ibsen) terminou a época sem um único -4. O vencedor de 2023/24 (Jonas Sand Labakk) fez apenas 3 hits em 38 jornadas — todos planeados à volta de blank/double gameweeks, nunca como reação de pânico. Entre o Top-50 de 2025/26, a maioria não fez nenhum hit. A conclusão é direta: poupar transferências (até ao máximo de 5) vale mais do que reagir a cada notícia.",
    source: "premierleague.com/en/news/4671784; premierleague.com/en/news/4025381; fantasyfootballfix.com Top-50 transfers series",
  },
  {
    title: "Decide o mais tarde possível",
    body: "Os melhores gestores concentram as decisões de transferência a sexta/sábado, perto do deadline, para incorporar notícias de última hora (conferências de imprensa, onzes prováveis) em vez de reagir a meio da semana com informação incompleta.",
    source: "Labakk: 'valorizei a informação do fim da semana mais do que o valor da equipa' — premierleague.com/en/news/4025381",
  },
  {
    title: "Núcleo template + diferenciais cirúrgicos",
    body: "Os gestores de elite não rejeitam o template — mantêm um núcleo de 'never sell' (ativos premium nailed-on) e só entram em diferenciais quando há uma razão concreta (lesão de um titular, mudança de fixtures, dados subjacentes a apontar para uma rotura), nunca por baixa posse pura. O sinal mais fiável para um diferencial compensar é evidência estatística subjacente (xGI, minutos seguros), não a percentagem de posse em si.",
    source: "allaboutfpl.com interviews; fploracle.team/blog/template-vs-differential-fpl",
  },
  {
    title: "Capitania: fixture e minutos seguros acima do nome",
    body: "A escolha de capitão mais consistente entre os melhores é o jogador premium mais 'nailed' com o fixture mais fácil — não necessariamente o nome mais caro da semana. Verificar sempre a probabilidade de minutos (chance_of_playing) antes de armar o capitão.",
    source: "Erik Ibsen interview, allaboutfpl.com/2026/03",
  },
  {
    title: "Chips: guardar para Double Gameweeks, nunca usar 'a meio'",
    body: "Padrão dominante 2025/26: 1º Wildcard por volta da GW4-6, 2º Wildcard por volta da GW32 a preparar uma Double Gameweek, seguido de Bench Boost (equipa toda fresca) e Free Hit a fechar a sequência. Bench Boost e Triple Captain valem exponencialmente mais numa Double Gameweek do que numa jornada normal — o Top-1000 usa Triple Captain 4x mais que o gestor médio (78% vs 20%).",
    source: "fantasyfootballfix.com/blog-index/fpl-top-50-tips-wildcards-2025-26; fantasyfootballscout.co.uk chip strategy guide",
  },
  {
    title: "Orçamento: meio-campo é onde está o valor",
    body: "Distribuição típica do Top-50: ~38% do orçamento em médios, ~28% em avançados, ~24% em defesas, ~9% em guarda-redes — mas sem se prenderem rigidamente a isto: 'não estavam presos a um único template, adaptavam-se a onde estava o valor.'",
    source: "fantasyfootballfix.com/blog-index/fpl-top-50-tips-budget-25-26",
  },
  {
    title: "Defesas baratas + Defensive Contribution = ferramenta de rotação",
    body: "A regra de Defensive Contribution (2 pontos por atingir 10+ CBIT em defesas, 12+ CBIRT em médios/avançados) tornou defesas baratas (£4.0-5.5m) com muitas ações defensivas viáveis para rodar consoante o calendário — uma alavanca que não existia antes de 2025/26.",
    source: "premierleague.com/en/news/4679873; fantasyfootballfix.com rotation series",
  },
  {
    title: "A sorte é real — foca-te no processo, não no resultado de uma jornada",
    body: "Os dois vencedores mundiais mais recentes admitem abertamente uma componente grande de sorte (um estima 60% sorte / 40% competência). A implicação prática: avalia as tuas decisões pela qualidade da informação e do raciocínio no momento, não retroativamente por teres acertado ou errado numa única jornada.",
    source: "allaboutfpl.com interviews",
  },
];

export interface RuleFact {
  label: string;
  value: string;
}

export const RULES_2026_27: { section: string; facts: RuleFact[] }[] = [
  {
    section: "Pontuação",
    facts: [
      { label: "Golo — GK / DEF", value: "10 / 6 pts" },
      { label: "Golo — MID / FWD", value: "5 / 4 pts" },
      { label: "Assistência", value: "3 pts" },
      { label: "Clean sheet — GK/DEF / MID", value: "4 / 1 pts" },
      { label: "Defensive Contribution", value: "+2 pts (DEF: 10+ CBIT · MID/FWD: 12+ CBIRT, tudo-ou-nada por jogo)" },
      { label: "Defesa (por cada 3 remates)", value: "1 pt" },
      { label: "Penalti defendido", value: "5 pts" },
      { label: "Penalti falhado / Cartão amarelo / Vermelho", value: "-2 / -1 / -3 pts" },
      { label: "2 golos sofridos (GK/DEF)", value: "-1 pt" },
      { label: "Bónus (BPS top 3 do jogo)", value: "3 / 2 / 1 pts" },
    ],
  },
  {
    section: "Equipa e Transferências",
    facts: [
      { label: "Orçamento inicial", value: "£100.0m" },
      { label: "Plantel", value: "15 jogadores — 2 GK / 5 DEF / 5 MID / 3 FWD" },
      { label: "Limite por clube", value: "Máx. 3 jogadores do mesmo clube" },
      { label: "Transferências grátis", value: "1 por jornada, acumula até 5" },
      { label: "Custo por transferência extra", value: "-4 pts" },
      { label: "Deadline", value: "90 min antes do 1º jogo da jornada" },
    ],
  },
  {
    section: "Chips (2 conjuntos completos em 2026/27)",
    facts: [
      { label: "Wildcard ×2", value: "Reset total sem custo de transferências" },
      { label: "Free Hit ×2", value: "Equipa livre só nessa jornada, reverte a seguir" },
      { label: "Bench Boost ×2", value: "Pontos do banco contam" },
      { label: "Triple Captain ×2", value: "Capitão vale ×3 em vez de ×2" },
      { label: "Deadline do 1º conjunto", value: "GW19 — 2 de janeiro de 2027" },
      { label: "Assistant Manager", value: "Removido — não existe em 2026/27" },
    ],
  },
];
