# Relatório do consultor externo — GW7/GW8 (23-10-2026)

## Objetivo e corte temporal
Avaliar estratégias de gestores com bom desempenho, o que aconteceu até à GW7 e como devemos avaliar a GW8. Este documento foi redigido antes de conhecer qualquer resultado da GW8. Os conselhos e hipóteses nunca são tratados como resultados confirmados.

## Factos de fontes públicas
- **Núcleo da elite GW7**: no top 10k (snapshot 20 outubro), Haaland 99,9%, João Pedro 97,9%, Calafiori 95,8%, Groß 93,8%, De Cuyper 87,0% e Rogers 82,0%. Fonte: https://www.fantasyfootballpundit.com/fpl-top-10k-ownership-table/ . Esta coorte é escolhida pelos resultados passados: não prova causalidade futura.
- **Capitania GW7**: numa amostra do top 10k, ~98,7% capitaneou Haaland, que marcou 13 pontos na GW7. Fonte: https://sidelinequant.com/elite/gw/7 . Amostragem e universo devem ser discriminados.
- **Capitania GW8**: o Scout oficial recomenda Haaland como primeira opção, apesar de João Pedro e Palmer terem jogo em casa com Tottenham. Haaland obteve oito golos e 56 pontos nas seis jornadas anteriores. Fonte: https://www.premierleague.com/en/news/4744364 . A seleção do Scout para GW8 usa Haaland capitão e Palmer vice: https://www.premierleague.com/en/news/4744348 . A app observada anteriormente recomendou João Pedro capitão; a divergência não prova erro até a jornada terminar e repetirmos o teste ao longo do tempo.
- **Disponibilidade**: notícia de 22 outubro indicou Haaland “100% available”. Fonte: https://www.fantasyfootballscout.co.uk/2026/10/22/fpl-gameweek-8-team-news-thursdays-live-injury-updates . É informação de atualidade curta, não uma característica permanente do jogador.
- **Competência histórica**: análise de 12 gestores com classificações top 10k em três épocas anteriores, distinta de escolher os primeiros da GW7. Fonte: https://www.fantasyfootballgeek.co.uk/fpl-transfer-tips-gw7-top-managers-131026/ . A amostra continua limitada e requer avaliação posterior.
- **Chips**: dois conjuntos de WC, FH, TC e BB em 2026/27, com primeiro conjunto a caducar na GW19 e só um chip por jornada. Fonte oficial: https://www.premierleague.com/en/news/4679879/whats-happening-with-fpl-chips-in-202627 .
- **Adoção não é rentabilidade**: FPLBubbles reportou 3.315.004 Wildcards e 3.382.788 Triple Captains utilizados até GW7, a partir do feed público FPL. Fonte: https://fplbubbles.com/en/fpl-chips/ . A utilização dos chips não demonstra que se jogaram na melhor semana.

## Auditoria adversarial ao modelo
1. **Backtest histórico incompleto**: lib/backtest.ts reconstrói partidas mas substitui a previsão histórica FPL por PPG, neutraliza notícias históricas não recuperáveis e não avalia exatamente o produto que existia antes do deadline.
2. **Amostragem**: lib/jobs.ts seleciona hoje jogadores com base em preço atual. Embora seja melhor do que pontuação acumulada, alterações de preço já podem refletir acontecimentos do período avaliado.
3. **Elite**: lib/elite.ts obtém capitania de gestores da GW anterior, que não é automaticamente a melhor previsão para a GW seguinte. Não usar posse elite como gatilho mecânico para WC.
4. **Chips**: um calendário de reservas para evitar a caducidade não mede completamente o ganho marginal de jogar agora contra esperar.
5. **Instrumentos**: lib/decisions.ts não replica todas as substituições automáticas nem demonstra, isoladamente, vantagem causal de transferências.
6. **Observabilidade**: a investigação tática foi vista parada ~44 dias e os cálculos pesados ocorrem durante carregamento; são problemas operacionais separados da precisão do algoritmo.
7. **Segurança**: o endpoint público de Shadow Team com escrita anónima foi fechado no bloco anterior; a persistência local continua até existir autenticação.

## Alteração operacional neste bloco
Criado benchmark prospectivo de previsões congeladas ANTES do deadline, com:
- previsões do modelo, média de pontos por jogo e previsão oficial FPL;
- coorte de jogadores elegíveis fixada antes da jornada segundo risco de não jogar e minutos esperados;
- comparação MAE, viés, Spearman e candidato a capitão para as mesmas observações sempre que possível;
- zeros reais incluídos; falta de previsão FPL indicada como falta, nunca valor zero;
- resultados apresentados apenas quando a jornada estiver marcada como concluída.

**Não são importados números retrospetivos como se fossem previsões arquivadas.** Não existe prova estatística de vantagem até haver observações prospectivas suficientes.

## Experiências prioritárias a realizar posteriormente
1. Comparar o capitão do motor, o capitão pelo EP oficial e uma coorte externa escolhida antes do deadline, sem selecionar vencedores retrospetivamente.
2. Testar alterações à previsão de minutos e à disponibilidade com métricas por faixa de probabilidade de jogar.
3. Comparar a política de transferências com "hold" e com políticas PPG, incluindo hits, FT e restrições de plantel — pontos líquidos reais por jornada.
4. Construir coorte histórica de gestores com desempenho em várias épocas antes de testar sinais da elite.
5. Testar a calendarização de chips contra ganho marginal e valor de esperar, respeitando caducidade GW19.
6. Medir tempo de resposta, timeout, custo Redis/API e atualizar automaticamente o estado da pesquisa de notícias.

## Critérios de promoção
Nenhuma alteração ao peso de um parâmetro de pontuação ou à política de chips é autorizada apenas por parecer plausível. Exigir comparação walk-forward sem leakage, amostra e incerteza reportadas, e regressão CI verde. As observações de uma jornada permitem diagnosticar, não declarar superioridade.
