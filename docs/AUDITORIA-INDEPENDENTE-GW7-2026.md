# Auditoria independente — FPL Command Center (23 outubro 2026)

## Mandato e evidência
Avaliar decisões recentes da FPL 2026/27, estratégias observadas nos gestores mais bem classificados e qualidade do motor de decisão. Separar **factos observáveis**, **hipóteses**, **experiências** e **recomendações aprovadas**. Não transformar uma correlação retrospectiva numa regra causal.

Fontes prioritárias: API pública FPL (bootstrap, histórico, picks por GW e classificações), resultados definitivos, decisões/snapshots arquivados antes do deadline e comunicados oficiais FPL. Contexto externo: relatórios sobre top-10k e análise oficial de atletas/fixtures. Exemplo verificável: https://www.premierleague.com/en/news e https://fantasy.premierleague.com .

## Diagnóstico prioritário (GW7 -> GW8)
1. **Viés da elite / seleção depois do resultado**: recolher top 200 depois da GW7 seleciona gestores que tiveram sorte nas primeiras sete jornadas. A posse de jogadores e a escolha de capitão nessa amostra não demonstram causalidade nem ganho futuro. Eliminar obrigação automática de incluir todos os jogadores com posse >=70% num Wildcard; eliminar o atalho de recomendar Wildcard apenas porque faltam >=2 jogadores populares.
2. **Probabilidades vs decisões**: o modelo optimiza EP mas o registo histórico (README v1.62) admite que a nova previsão não vence de forma convincente a referência simples pontos/jogo; Spearman documentado 0,338 -> 0,352 e MAE piora 0,08. Sem vitória fora da amostra, a ferramenta deve apresentar incerteza e abster-se quando a diferença está dentro do erro.
3. **Hindsight leakage no backtest**: o código reconstrói passado, mas usa proxy da previsão FPL quando ela não existe arquivada e neutraliza notícias antigas. Isto é uma avaliação incompleta do sistema real. Registar previsões e parâmetros *antes* de cada deadline e avaliar apenas snapshots imutáveis para o benchmark principal.
4. **Capitania**: o capitão da elite na GW anterior não é, por definição, o melhor capitão da GW seguinte. Separar *capitania observada na GW anterior* de previsão pré-deadline atual; comparar EP, disponibilidade, capitão de consenso e diferencial com resultados de fora da amostra.
5. **Chips**: o calendário é um plano de reserva para evitar caducidade, não uma ordem de utilização. Wildcard deve exigir vantagem marginal contra continuar com a equipa, considerando FT, hits, valor da flexibilidade, calendário e qualidade das previsões.
6. **Saúde da investigação**: tarefa externa de insights táticos aparece parada ~44 dias na aplicação inspecionada. Antes de usar essa camada, definir SLA de atualização, validade, origem e modo degradado; bloquear notas antigas.
7. **Segurança**: /api/shadow-team permitia qualquer POST anónimo alterar a mesma chave Redis; desativado nesta branch até haver sessão autenticada. Tokens em query string devem migrar para cabeçalhos ou ponte autenticada.
8. **Custo/performance**: página SSR realiza solver + Monte Carlo + múltiplas chamadas. Migrar snapshots pesados para jobs, medir p50/p95, falhas por endpoint, custos de Redis e API, tempo até primeira resposta.
9. **Qualidade de apresentação**: uma recomendação principal única por GW e alternativas explicitamente condicionais, com ganho líquido, margem de erro, confiança, pressupostos e data/hora da origem.

## Plano de medição proposto
- Comparar, por GW e acumulado, estratégia atual, baseline pontos por jogo, baseline FPL ep_next, consenso pré-deadline e política hold/transferência disciplinada.
- Medir MAE, Brier para disponibilidade, Spearman, top-decile lift, regret das escolhas de capitão, pontos líquidos do XI com auto-subs, saldo de transferências, custo de hits e oportunidade dos chips.
- Submeter cada mudança a teste walk-forward temporal; manter conjuntos separados para desenvolvimento e avaliação final. Métricas agregadas por GW, intervalos de confiança sobre jornadas, não sobre milhares de jogadores correlacionados.
- Guardar para cada decisão: GW, horário do snapshot, hash/parâmetros do modelo, data freshness, fontes, onze, banco, C/VC, transferências, FT, preços de venda, chips e alternativas consideradas.
- Bloquear promoção de nova regra que não supere baseline em ganhos líquidos com evidência suficiente; sem evidência, marcar experimental. Nenhuma integração externa deve alterar diretamente a pontuação sem validação e expiração.

## Sequência de execução
**P0 (desta branch):** segurança de Shadow Team; unidades de pontos na Shadow Team; estado real do armazenamento; remover viés imediato de Wildcard/elite; testes de regressão.
**P1:** capturar snapshots pre-deadline completos e benchmark retrospectivo honesto; comparar capitania, transferências e chips nas GW seguintes.
**P2:** recuperar pesquisa tática com fontes e validade temporal; benchmarking da elite em amostras fixas selecionadas *antes* dos resultados.
**P3:** performance, observabilidade, simplificação modular e interface de decisão unificada.

## Condições para avançar
Testes CI verdes, confirmação do deploy, provas de comportamento em produção e análise de segurança posterior. A branch não altera a equipa FPL real nem executa transferências.
