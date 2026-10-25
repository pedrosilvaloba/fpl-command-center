# FPL Command Center — execução do mega bloco (25/10/2026)

## Princípios
Não confundir sofisticação com vantagem competitiva. Nenhuma mudança nos pesos do modelo é promovida porque parece plausível. Esta alteração reorganiza a experiência e repara medições e identidade; não executa ações na conta oficial da Fantasy.

## Funcionalidades integradas
- **Quatro experiências em vez de um único relatório longo:** Hoje, Simular, Analisar, Sistema. Cada vista tem navegação direta e envia menos componentes desnecessários ao browser. A computação pesada do servidor continua a necessitar de otimização arquitetural posterior.
- **Team ID único, público e persistente:** ?team= prevalece; sem parâmetro, cookie SameSite Lax ou ID por omissão. Migração da antiga preferência localStorage. O planeador, simulador, chips, liga e painel da equipa passam a usar a mesma identidade. Qualquer URL para simulação mantém o Team ID.
- **Histórico de conselhos imutável:** para a equipa principal, o primeiro conselho automático pré-deadline de cada GW é gravado com SET NX. O evento fica marcado como previsão automática, e NÃO como decisão executada pelo utilizador. Dados históricos pré-existentes são mantidos. Visitas de outras equipas não tocam no histórico do proprietário.
- **Decisão contextual:** comparação de planos de transferências, dos hits, ganho vs não transferir e valor de aguardar por FT, com slider determinístico para depreciação hipotética de pontos dos reforços.
- **3 cenários de Wildcard já existentes:** equilibrado (cinco GW), próxima jornada e continuidade, com inclusão de jogadores/limites de orçamento.
- **Campo mobile explorável:** toque na camisola apresenta disponibilidade, minutos, projeção, notícias e justificações; nenhuma informação médica nova é inventada.
- **Benchmark retrospetivo/prospetivo distinguido:** o benchmark pré-deadline avalia também todo o universo de jogadores e faixas de probabilidade de jogar, sem eliminar zeros reais; comparação de capitania restrita aos jogadores da equipa arquivada.
- **Origem e incerteza visíveis:** Team ID, estado de dados FPL/odds, natureza experimental da projeção.
- **Testes de regressão** para identidade, navegação, preservação de parâmetros, risco, planos e elegibilidade de capitães.

## Limitações importantes (não mascarar como entregas)
- **Otimização multiperíodo 3–8 GW**: não implementada integralmente. O adiamento continua a ser a comparação heurística do mesmo planeador com uma FT extra, e não uma árvore de decisões replaneada.
- **Modelo de minutos**: a recência de papéis, escalação provável e lesões ainda não é validada com histórico de presenças jogo a jogo. A melhoria entregue foi transparência e avaliação de risco, não um novo preditor comprovadamente superior.
- **Autenticação pessoal**: a app não tem login. As recomendações automáticas não constituem decisões humanas. Uma sessão autenticada é pré-requisito para guardar decisões confirmadas pelo utilizador e eventual sincronização privada.
- **Consultor IA conversacional**: não ligado a um LLM externo nesta versão por não existir gateway e política de custos/privacidade aprovados. Perguntas estruturadas e simulações continuam determinísticas e gratuitas.
- **Vantagem estatística do modelo**: ainda não comprovada contra baselines fora da amostra; guardar snapshots completos é necessário antes de poder comparar.
- **UX visual**: validada por código e CI; é necessária uma inspeção real de 320–430px, contraste, VoiceOver e testes com utilizadores para declarar a UX finalizada.
- **Performance**: quatro vistas reduzem conteúdo entregue ao browser, mas não todas as computações SSR. Separar funções por serviço e pré-calcular cache exigirá etapa posterior.
- **Segurança/Dependências**: investigar avisos npm audit existentes, e proteger operações privadas antes de colocar novos dados de utilizador.
- **Deployment**: confirmar build Ready no projeto Vercel correto e a revisão Git em /api/health. CI do GitHub não equivale a publicação.

## Próximos gates do produto
1. Testes e2e em ambiente publicado, confirmação do Team ID entre vistas e isolamento dos históricos.
2. Medição real de latência, CLS e LCP, sobretudo mobile; pré-cálculo de Monte Carlo/solver se necessário.
3. Arquivo de previsões de minutos e capitania com a coorte de 15 jogadores efetivamente disponíveis antes do prazo.
4. Walk-forward e comparação de ganhos líquidos de transferências e chips; critérios de promoção com intervalos de incerteza por GW.
5. Desenvolvimento separado da árvore de decisões 3–8 GW, com objetivos e orçamentos auditáveis.

## Não feito
Sem transferências reais, sem modificar a conta oficial FPL, sem apagar Redis/histórico, sem gastar créditos com fornecedores de IA.
