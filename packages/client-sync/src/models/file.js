const base64 = require('base64-stream');
const {
  ExponentialBackoffScheduler,
  IMAPErrors,
  IMAPConnectionPool,
} = require('isomorphic-core')
const {QuotedPrintableStreamDecoder} = require('../shared/stream-decoders')
const {Actions} = require('nylas-exports')

const MAX_IMAP_TIMEOUT_ERRORS = 5;

module.exports = (sequelize, Sequelize) => {
  return sequelize.define('file', {
    id: { type: Sequelize.STRING(500), primaryKey: true },
    size: Sequelize.INTEGER,
    partId: Sequelize.STRING,
    version: Sequelize.INTEGER,
    charset: Sequelize.STRING,
    encoding: Sequelize.STRING,
    filename: Sequelize.STRING(500),
    messageId: { type: Sequelize.STRING, allowNull: false },
    accountId: { type: Sequelize.STRING, allowNull: false },
    contentType: Sequelize.STRING(500),
    contentId: Sequelize.STRING(500),
  }, {
    indexes: [
      {fields: ['messageId']},
    ],
    classMethods: {
      associate: ({File, Message}) => {
        File.belongsTo(Message)
      },
    },
    instanceMethods: {
      async fetch({account, db, logger}) {
        const message = await this.getMessage()
        const folder = await message.getFolder()

        let numTimeoutErrors = 0;
        let result = null;

        const onConnected = async ([connection], done) => {
          const imapBox = await connection.openBox(folder.name)
          const stream = await imapBox.fetchMessageStream(message.folderImapUID, {
            fetchOptions: {
              bodies: this.partId ? [this.partId] : [],
              struct: true,
            },
            onFetchComplete() {
              done();
            },
          });

          if (!stream) {
            throw new Error(`Unable to fetch binary data for File ${this.id}`)
          }

          if (/quoted-printable/i.test(this.encoding)) {
            result = stream.pipe(new QuotedPrintableStreamDecoder({charset: this.charset}));
            return true;
          } else if (/base64/i.test(this.encoding)) {
            result = stream.pipe(base64.decode());
            return true;
          }

          // If there is no encoding, or the encoding is something like
          // '7bit', '8bit', or 'binary', just return the raw stream. This
          // stream will be written directly to disk. It's then up to the
          // user's computer to decide how to interpret the bytes we've
          // dumped to disk.
          result = stream;
          return true;
        };

        const timeoutScheduler = new ExponentialBackoffScheduler({
          baseDelay: 15 * 1000,
          maxDelay: 5 * 60 * 1000,
        });

        const onTimeout = () => {
          numTimeoutErrors += 1;
          Actions.recordUserEvent('Timeout error downloading file', {
            accountId: account.id,
            provider: account.provider,
            socketTimeout: timeoutScheduler.currentDelay(),
            numTimeoutErrors,
          });
          timeoutScheduler.nextDelay();
        };

        while (numTimeoutErrors < MAX_IMAP_TIMEOUT_ERRORS) {
          try {
            await IMAPConnectionPool.withConnectionsForAccount(account, {
              desiredCount: 1,
              logger,
              socketTimeout: timeoutScheduler.currentDelay(),
              onConnected,
            });
            break;
          } catch (err) {
            if (err instanceof IMAPErrors.IMAPConnectionTimeoutError) {
              onTimeout();
              continue;
            }
            throw err;
          }
        }
        return result;
      },

      toJSON() {
        return {
          id: this.id,
          size: this.size,
          object: 'file',
          part_id: this.partId,
          encoding: this.encoding,
          filename: this.filename,
          message_id: this.messageId,
          account_id: this.accountId,
          content_type: this.contentType,
          content_id: this.contentId,
        };
      },
    },
  });
};
