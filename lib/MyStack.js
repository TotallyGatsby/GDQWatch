import * as sst from "@serverless-stack/resources";

export default class MyStack extends sst.Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    const notificationsTable = new sst.Table(this, 'NotificationTimes', {
      fields: {
        hook: sst.TableFieldType.STRING,
        time: sst.TableFieldType.STRING,
        token: sst.TableFieldType.STRING,
      },
      primaryIndex: { partitionKey: 'hook' },
    });

    // Don't allow calling these endpoints in prod, but it's convenient to be able to call them
    // directly in dev.
    if (process.env.IS_LOCAL) {
      // Create a HTTP API
      const api = new sst.Api(this, "Api", {
        defaultFunctionProps: {
          // Pass in the table name to our API
          environment: {
            notificationsTable: notificationsTable.tableName,
          },
        },
        routes: {
          "GET /": "src/lambda.handler",
        },
      });

      api.attachPermissions([notificationsTable]);

      // Show the endpoint in the output
      this.addOutputs({
        "ApiEndpoint": api.url,
      });
    } else {
      const cron = new sst.Cron(this, 'GDQWatch', {
        schedule: 'cron(*/3 * * * ? *)',
        job: {
          handler: 'src/lambda.handler',
          environment: {
            notificationsTable: notificationsTable.tableName,
          },
        },
      });
      cron.attachPermissions([notificationsTable]);
    }
  }
}
