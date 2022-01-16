import { parse } from 'node-html-parser';
import { DateTime } from 'luxon';
import fetch from 'node-fetch';
import { DynamoDBClient, ScanCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';


const gdqUrl = 'https://gamesdonequick.com/schedule/';
const ddbClient = new DynamoDBClient({ region: 'us-west-2' });

function timeString(time, timeZone) {
  return DateTime.fromISO(time).setZone(timeZone).toLocaleString(DateTime.TIME_SIMPLE);
}

function constructEmbed(nextRun, onDeckRun) {
  return {
    "tts": false,
    "embeds": [
      {
        title: null,
        type: "rich",
        description: null,
        url: null,
        timestamp: 0,
        color: 15865927,
        fields: [
          { name: 'Next Game:', value: nextRun.run },
          { name: 'Start Time', value: `${timeString(nextRun.time, "America/Los_Angeles")} PST / ${timeString(nextRun.time, "America/New_York")} EST`, inline: true },
          { name: 'Estimate', value: nextRun.estimate, inline: true },
          { name: 'Runner', value: nextRun.runners, inline: true },
          { name: '\u200B', value: '\u200B' },
          { name: 'On Deck:', value: onDeckRun.run },
          { name: 'Start Time', value: `${timeString(onDeckRun.time, "America/Los_Angeles")} PST / ${timeString(onDeckRun.time, "America/New_York")} EST`, inline: true },
          { name: 'Estimate', value: onDeckRun.estimate, inline: true },
          { name: 'Runner', value: onDeckRun.runners, inline: true },
        ],
        thumbnail: null,
        image: null,
        author: null,
        footer: null
      }],
  };
}

export async function handler() {
  let nextRun;
  let onDeckRun;

  await fetch(gdqUrl)
    .then(res => res.text())
    .then((body) => {
      const root = parse(body);
      const runs = root.querySelectorAll('#runTable tbody tr')
        .map((row) => {
          const tds = row.querySelectorAll('td');
          if (tds.length === 4) {
            return {
              time: tds[0].text.trim(),
              run: tds[1].text.trim(),
              runners: tds[2].text.trim()
            };
          } else if (row.classNames.includes('second-row')) {
            return {
              estimate: tds[0].text.trim()
            }
          }
        })
        .reduce((runAccumulator, run) => {
          if ('estimate' in run) {
            runAccumulator[runAccumulator.length - 1].estimate = run.estimate;
          } else {
            return [...runAccumulator, run];
          }
          return runAccumulator;
        }, []);

      // Find the next run and the on deck run
      console.log(`Found ${runs.length} runs on the schedule`);

      let index = 0;
      const nowTime = new Date();

      while (!onDeckRun && index < runs.length) {
        let runTime = new Date(runs[index].time);

        if (runTime > nowTime) {
          nextRun = runs[index];
          onDeckRun = runs[index + 1];
        }
        index++;
      }
    });


  const nextRunTime = DateTime.fromISO(nextRun.time);
  const timeTilNextRun = nextRunTime.diffNow('minutes').toObject().minutes;

  console.log(`Next run starts in ${timeTilNextRun} minutes`);

  if (timeTilNextRun > 15) {
    console.log(`Sleeping, nothing to report. ${process.env.notificationsTable}`);
    return {
      statusCode: 200,
      headers: { "Content-Type": "text/plain" },
      body: `Sleeping til next run in ${timeTilNextRun} minutes.`,
    };
  }

  const embedObject = constructEmbed(nextRun, onDeckRun);

  const command = new ScanCommand({ TableName: process.env.notificationsTable });
  const response = await ddbClient.send(command);
  const notificationClients = response.Items;

  await Promise.all(
    notificationClients.map(async (client) => {
      const jsonClient = unmarshall(client);
      const lastNoticeTime = DateTime.fromISO(jsonClient.time);
      const timeSinceLastUpdate = DateTime.now().diff(lastNoticeTime, 'minutes').toObject().minutes;

      if (timeSinceLastUpdate > 20) {
        console.log(`SENDING MESSAGE to hook ${jsonClient.hook} whose last notification was ${timeSinceLastUpdate} minutes ago.`);

        await fetch(`https://discord.com/api/webhooks/${jsonClient.hook}/${jsonClient.token}`, {
          method: 'post',
          body: JSON.stringify(embedObject),
          headers: { 'Content-Type': 'application/json' }
        });

        jsonClient.time = DateTime.now().toISO();

        await ddbClient.send(new PutItemCommand({
          TableName: process.env.notificationsTable,
          Item: marshall(jsonClient),
        }));
      }
    }));

  return {
    statusCode: 200,
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({
      nextRun,
      onDeckRun,
    }, null, 2),
  };
}
