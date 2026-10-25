# Recuperação das investigações — 2026-10-25

## Causas comprovadas
- A investigação externa dependia de uma sessão Claude que deixou de submeter notas em 8 de setembro. Receber notas por API não é o mesmo que recolher artigos automaticamente.
- A observação oficial foi publicada depois dos crons da manhã de 25 de outubro e era executada apenas no horário das 06:00.
- Avisos Next.js de bootstrap FPL acima de 2 MB são um problema independente de cache, não a causa comprovada da ausência de jobs.

## Implementação
- Pesquisa editorial autónoma via RSS Fantasy Football Scout, BBC Football, Guardian Football, sem IA paga.
- Artigos com título, URL e data verificáveis; feeds HTTPS em domínios fixos, limites de payload e timeout.
- Observação oficial FPL, independente, com cache de seis horas.
- Às 06:00 e às 07:00 ambos os relatórios têm redundância e registo de execução; segundo horário evita repetir downloads recentes.
- Endpoint read-only de estado e recuperação condicionada, limitado por lock Redis NX a cada 15 minutos para fontes públicas, sem introduzir URLs ou dados de utilizador.
- UI e endpoint de automações distinguem investigação editorial e notas de especialistas antigas; recolha não altera automaticamente projeções.
- Testes de datas, origem RSS, domínios seguros e agendamento.

## Limitações
- RSS é descoberta editorial e não análise profunda de tática feita por IA. Qualquer interpretação/ponderação terá de ter procedimento independente e validação do impacto.
- A publicação e execução em produção devem ser confirmadas por /api/research e /api/automation, não apenas por CI.
- Permanecem fora deste bloco o otimizador multiperíodo real, preditor avançado de minutos, consultor conversacional e autenticação pessoal.
- Os avisos de cache >2 MB do bootstrap FPL merecem correção autónoma.
