# Coletas em nuvem

## Preparação local de 01/11/2026 — intervalo de quatro horas

A nova frequência está preparada no código e na configuração, **sem publicação
ou ativação externa nesta alteração**. O ambiente padrão continua sem crons.
O ambiente `production` está preparado com `0 1,5,9,10,11,13,17,21 * * *` UTC:

- **01, 05, 13, 17 e 21 UTC:** solicita somente `build-feed.yml`, para coletar
  promoções e registrar observações do histórico. Não repete o workflow de
  taxas nem a atualização diária de referências.
- **09 UTC:** mantém `refresh-br-ratios.yml` e o build encadeado ao final.
- **10 e 11 UTC:** mantém, respectivamente, a recuperação diária condicional
  e a verificação final, sem uma nova tentativa às 11 UTC.

Assim, as seis coletas programadas ficam separadas por quatro horas, incluindo
a virada do dia. O histórico só pode resolver uma janela como “não observada”
quando há amostras saudáveis com lacunas de no máximo seis horas. A frequência
preparada permite formar essa evidência; não comprova que a coleta ocorreu.
Falhas, atrasos e lacunas maiores continuam como coleta incompleta, fora das
métricas de resultado. O acompanhamento prospectivo depende da ativação e da
persistência das observações em cada execução do feed.

Nos horários extras, uma execução do feed em andamento recente ou já iniciada
no mesmo ciclo impede outro disparo sequencial. Uma tentativa concluída com
falha também bloqueia ticks duplicados daquele ciclo; o próximo horário tem
seu próprio ciclo. A resposta de dispatch não declara coleta ou publicação
concluída. Permanece a limitação de concorrência antes de o GitHub registrar
a execução: não há trava distribuída nem garantia de execução exatamente uma vez.

## Recuperação de cobertura em 23/10/2026

A coleta do feed agora repete falhas transitórias de HTTP/rede até três vezes,
com intervalos de 1,5 e 3 segundos. Diretórios vazios ou incompletos também
passam por novas tentativas; uma falha persistente continua explícita.

O relógio mantém a coleta das 06h de Brasília. Às 07h verifica o resultado e
solicita uma única recuperação se a verificação falhou. Com dados saudáveis,
não há segunda coleta. Às 08h confere o resultado final, sem nova tentativa.
Uma execução de recuperação já iniciada impede outro disparo sequencial na
mesma janela, inclusive quando falhou. Eventos simultâneos ainda podem
concorrer antes de o GitHub registrar a execução; não há trava distribuída.
O cron preparado nessa intervenção era `0 9,10,11 * * *` UTC. Não foram adicionados serviços,
segredos, planos pagos ou canais externos de notificação.


## Correção de 18/10/2026

Os eventos de 06h e 07h falhavam antes de acessar o GitHub: Workers rejeita
`redirect: 'error'`. A versão `2fb4743d-443f-4c34-ac89-90622faab56e`, publicada
em 18/10 às 20h09 BRT, usa `redirect: 'manual'` e rejeita respostas não 2xx,
sem seguir redirecionamentos ou encaminhar credenciais a outro host.
Versão ativa, cron e presença do secret foram confirmados pela API.
O teste no runtime local reproduziu a falha original e confirmou o dispatch
corrigido e a rejeição de redirecionamentos. Suíte: 201 aprovados, 1 ignorado.
O próximo evento automático após a correção será em 19/10 às 06h BRT e ainda
não foi observado. A recuperação manual publicou o feed de 18/10 às 20h05,
com cobertura parcial: Esfera com timeout e Frequent Miler com uma oferta
sem data. Evidências locais: `reports/scheduler-fix-2026-10-18/` na raiz do
workspace. A correção está no Worker e na cópia local; não foi enviada ao
repositório GitHub nesta intervenção.

Configuração de 13/10/2026: coleta diária às 06h e verificação às 07h de
Brasília. O ambiente `production` ativa o cron; a configuração padrão o pausa.
A conta Cloudflare foi conferida no plano Free. Nenhum plano pago foi ativado.

**Ativado em 13/10/2026.** Worker e cron confirmados pela API Cloudflare;
secret `GITHUB_TOKEN` confirmado pelo nome, sem exposição. A coleta manual
completa passou e disparou o build automático com sucesso. O primeiro disparo
do relógio é em 14/10/2026 às 06h e ainda não foi observado nesta ativação.
Versão inicial ativa: `0e595b3b-8527-449d-8009-8a7d167811f7`.

## Funcionamento preparado para a próxima ativação

- **06h de Brasília:** Cloudflare solicita `Refresh BR ratios`. O job confere
  parceiros, taxas, estimativas de valor e prazos com fonte, testa e salva as mudanças verificadas.
  Sua conclusão dispara `Build feed`: promoções, histórico, validação e Pages.
- **07h:** verifica o resultado do job de taxas e a publicação efetiva. O feed
  e suas fontes precisam ter sido verificados depois da conclusão do job de
  taxas. Se a verificação falhar e não houver uma execução em andamento, solicita uma recuperação limitada.
- **08h:** verifica a publicação final e registra falha se a cobertura continuar incompleta, sem nova coleta.
- **02h, 10h, 14h, 18h e 22h de Brasília:** solicita somente `Build feed`,
  complementando a coleta das 06h para manter o intervalo de quatro horas.
- O Worker centraliza o agendamento; não é necessário acrescentar outro cron
  no GitHub. Os dois workflows continuam disponíveis para execução manual.
- A extensão avisa quando o feed passa de **36 horas**. A checagem das 07h
  detecta a falta da publicação do dia antes desse prazo. A expiração das
  promoções continua ocorrendo pelo relógio, sem depender de nova coleta.

O Worker evita solicitar execução já recente/em andamento. Eventos simultâneos
ainda podem passar por essa consulta; os workflows serializam as execuções e
atualizam dados de forma idempotente. Não é garantia de execução exatamente uma
vez. Falhas de cron ficam registradas no Cloudflare. **Nenhum canal novo de
notificação externa foi configurado.** Permanecem os registros de erro existentes
no GitHub.

## Custo previsto: zero, dentro das franquias

Na configuração preparada, são um cron e oito invocações por dia: seis coletas
programadas e duas verificações, com uma recuperação diária possível. Não há
KV, banco ou endpoint público.
O Workers Free inclui 100 mil invocações/dia, 10 ms de CPU/invocação e até cinco
crons por conta. A espera da rede não conta como CPU. Os limites são
compartilhados com outros Workers; conferir capacidade antes da ativação.
O dry-run valida o build, não mede CPU em produção. Não habilitar plano pago.

O repositório `lucasmlessa-hash/transfer-radar-data` foi confirmado público,
com runners padrão, cujos minutos são gratuitos. Os artefatos Pages são
pequenos/temporários; armazenamento continua sujeito à franquia da conta.

Fontes verificadas em 13/10/2026:

- [Preços Workers](https://developers.cloudflare.com/workers/platform/pricing/)
- [Limites Workers](https://developers.cloudflare.com/workers/platform/limits/)
- [Cron em UTC](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [GitHub Actions: gratuidade e armazenamento](https://docs.github.com/en/billing/concepts/product-billing/github-actions)

## Credencial necessária

Token GitHub **fine-grained** criado e salvo como segredo no Worker, restrito ao repositório
`transfer-radar-data`, com **Actions: Read and write**, válido até **13/10/2027**.
Renovar antes dessa data: token expirado interrompe o agendamento. Não precisa de permissão Contents.
[Permissões oficiais](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event).

Não reutilizar o token amplo de `gh auth`, nem colocar segredo no chat, código
ou argumento de comando. Salvar apenas como secret `GITHUB_TOKEN` do Worker,
usando o prompt interativo do Wrangler ou o campo protegido do Cloudflare.

## Ativação

1. Conferir plano e disponibilidade de um cron na conta Cloudflare. Este Worker
   tem nome próprio e não modifica o projeto Refúgio.
2. Publicar o Worker **sem cron**, a partir da raiz do repositório de dados:

   ```sh
   npx wrangler@4.92.0 deploy --config cloud-scheduler/wrangler.jsonc
   npx wrangler@4.92.0 secret put GITHUB_TOKEN --config cloud-scheduler/wrangler.jsonc --env production
   ```

3. Publicar os workflows e testes no repositório de dados, preservando ledger
   remoto e commits do bot. O `Build feed` deve persistir as observações do
   histórico em cada coleta, além de manter a primeira emissão da coorte diária.
   Nunca usar force-push.
4. Disparar `Refresh BR ratios` manualmente. Conferir seu resultado, o build
   encadeado e a data do feed publicado. Se falhar, manter/restaurar o cron antigo
   até o reparo, sem apagar o último feed válido.
5. Ativar o relógio:

   ```sh
   npx wrangler@4.92.0 deploy --config cloud-scheduler/wrangler.jsonc --env production
   ```

6. Confirmar que o secret existe pelo nome, sem imprimir o valor. A propagação
   do cron pode levar 15 minutos. Acompanhar as execuções reais diárias e as
   coletas intermediárias, inclusive o intervalo entre amostras saudáveis:
   dry-run e aceite HTTP do GitHub não comprovam coleta concluída. Recarregar
   a extensão para aplicar o prazo diário no painel.

Para pausar, publicar a configuração padrão, sem `--env production`, com a lista
de crons vazia. Essa ação deixa apenas execuções manuais; para voltar ao GitHub
temporariamente, restaurar um cron diário no workflow de taxas. Preparação e
produção usam o mesmo nome de Worker; escolher o ambiente deliberadamente.

## Verificação local

```sh
npm test
npx wrangler@4.92.0 deploy --dry-run --config cloud-scheduler/wrangler.jsonc --env production
```

Os testes simulam apenas o transporte HTTP: token ausente/negado, aceite 200/204,
duplicatas por ciclo, falha nas taxas, feed antigo ou anterior às taxas, fonte
ausente, cobertura parcial, datas futuras e isolamento da credencial. Também
conferem a cadência de quatro horas, o dispatch exclusivo do feed nos novos
horários, a preservação do fluxo diário e a rejeição dos demais horários.
Não disparam workflows reais nem usam tokens reais.

## Cobertura e limites

- Diretórios e razões dos bancos US/BR: conectores existentes, conferidos diariamente.
- Hotéis: Marriott 8/8, Choice 2/2 e Wyndham 1/2 das rotas cadastradas, pelas fontes oficiais.
  Wyndham → United permanece sem taxa base confirmada, exibida como `—`. A API
  não separa claramente o bônus da taxa base; o relatório registra essa lacuna.
  Novas parcerias de hotéis fora das rotas cadastradas ainda exigem ampliar o diretório.
- Estimativas de resgate: 24 programas conferidos no Frequent Miler/TPG; 13 valores
  legados sem revalidação automática ficam fora dos cálculos quando não têm
  fonte válida ou revisão de até 35 dias. Não são preços garantidos de milhas.
- Prazos: 98 rotas com estimativa explícita no Frequent Miler na ativação. As
  demais permanecem sem prazo confirmado. São observações, não SLA dos programas.

Os relatórios `hotel-ratios-health.json`, `point-valuations-health.json` e
`transfer-times-health.json` acompanham o feed publicado. Falha não renova a
data de conferência, e mudanças verificadas de fontes independentes podem ser
publicadas mesmo quando outra fonte falha. Nenhum scraper garante cobrir todo o
mercado ou promoções lançadas e encerradas entre duas coletas.

O TPG apresentou respostas alternadamente completas e parciais no runner.
O refresh usa até três tentativas limitadas, sem juntar valores de respostas
diferentes. Se a fonte permanecer incompleta, conserva valores/datas anteriores,
registra a falha e guarda somente o HTML público em artefato de diagnóstico com
retenção de um dia. Um resultado parcial nunca é marcado como conferência completa.
