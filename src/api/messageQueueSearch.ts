 /* searchUserMessage */
import util from "util";
import fs from "fs";
import tmp from "tmp";
import { CommandResult } from "@halcyontech/vscode-ibmi-types";
import { Code4i, makeid } from "../tools";
import { isProtectedFilter } from '../filesystem/qsys/MsgQFs';
import { IBMiContentMsgq } from "./IBMiContentMsgq";
import { FuncInfo, IBMiMessageQueue } from '../typings';

const tmpFile = util.promisify(tmp.file);
const writeFileAsync = util.promisify(fs.writeFile);

export namespace MessageQueueSearch {

  export interface Result {
    path: string
    lines: Line[]
    readonly?: boolean
    label?: string
    contextValue?: string
  }
  export interface Line {
    number: number
    content: string
  }

  export async function searchMessageQueue( searchTerm: string, filter: IBMiMessageQueue, searchWords?: string, messageID?: string): Promise<Result[]> {
    const connection = Code4i.getConnection();
    const config = Code4i.getConfig();
    const content = Code4i.getContent();

    if (connection && config && content) {

      const client = connection.client;
      const tempLib = config.tempLibrary;
      const tempName = makeid();
      const tempRmt = connection.getTempRemote(tempLib + `VSC_TMP_1` + `VSC_TMP_1`);
      if (tempRmt) {
        const tmpobj = await tmpFile();

        const setccsid = connection.remoteFeatures.setccsid;
        // const objects = await IBMiContentMsgq.getMessageQueueMessageList(filter.messageQueue, filter.messageQueueLibrary, { order: "date", ascending: true }, searchWords, messageID);

        // const workFileFormat = {
        //   messageQueueLibrary: objects[0].messageQueueLibrary,
        //   messageQueue: objects[0].messageQueue,
        //   messageID: objects[0].messageID,
        //   messageKey: objects[0].messageKey,
        //   messageText: objects[0].messageText
        // };
        // let largeString = JSON.stringify(workFileFormat);
        const query: string[] = [
          // `create or replace table ${tempLib}.${tempName} as (`,
          `select MESSAGE_ID, MESSAGE_KEY, MESSAGE_TEXT`,
          `from table ( QSYS2.MESSAGE_QUEUE_INFO(`,
          ` QUEUE_NAME => '${filter.messageQueue}'`,
          ` QUEUE_LIBRARY => '${filter.messageQueueLibrary}')`,
          `${messageID ? ` and MESSAGE_ID = '${messageID}'`:''}`,
          `${searchWords ?` and (MESSAGE_TEXT like '%${searchWords}%' or MESSAGE_SECOND_LEVEL_TEXT like '%${searchWords}%')`:''}`,
          ` order by MESSAGE_TIMESTAMP ${!sort.ascending ? 'desc' : 'asc'}`,
        // with USER_SPOOLED_FILES (SFUSER,OUTQ,QJOB,SFILE,SFNUMBER) as (
        //   select "user","queue","qjob","name","number" from JSON_Table(
        //     '${largeString}' 
        //     ,'lax $' COLUMNS( "user" char(10),"queue" char(10),"qjob" char(28),"name" char(10),"number" dec(6,0) 
        //       )) as SPLF ) select * from USER_SPOOLED_FILES ) 
          // `with no data;`
        ];
        const recordLength = `{"user":"ABCDEFGHIJ","queue":"ABCDEFGHIJ","qjob":"591022/ABCDEFGHIJ/ABCDEFGHIJ","number":"00001"}`.length;
        const decimalSequence = objects.length;
        let insRows: string[] = [],
          sequence = 0;
        for (let i = 0; i < objects.length; i++) {
          sequence = decimalSequence ? ((i + 1) / 100) : i + 1;
          insRows.push(
            `('${objects[i].user}', '${objects[i].queue}', '${objects[i].qualifiedJobName}', '${objects[i].name}', '${objects[i].number}')`
          );
        }

        // Row length is the length of the SQL string used to insert each row
        const rowLength = recordLength + 55;
        // 450000 is just below the maxiumu length for each insert.
        const perInsert = Math.floor(400000 / rowLength);
        const insRowGroups = sliceUp(insRows, perInsert);
        insRowGroups.forEach(insRowGroup => {
          query.push(`insert into ${tempLib}.${tempName} values ${insRowGroup.join(`,`)};`);
        });
        await writeFileAsync(tmpobj, query.join(`\n`), `utf8`);
        await client.putFile(tmpobj, tempRmt);
        if (setccsid) {await connection.sendCommand({ command: `${setccsid} 1208 ${tempRmt}` });}
        await connection.runCommand({
          command: `QSYS/RUNSQLSTM SRCSTMF('${tempRmt}') COMMIT(*NONE) NAMING(*SQL)`
          , environment: `ile`
        });
        // on-server list of spooled files to search is built, now use in conjunction with searching that list of report data
        const sqlStatement =
          `with ALL_USER_SPOOLED_FILE_DATA (SFUSER,OUTQ,QJOB,SFILE,SFNUMBER,SPOOL_DATA,ORDINAL_POSITION) as (
        select SFUSER,OUTQ,QJOB,SFILE,SFNUMBER,SPOOLED_DATA,SD.ORDINAL_POSITION
          from ${tempLib}.${tempName}
          ,table (SPOOLED_FILE_DATA(trim(QJOB),SFILE,SFNUMBER,'NO')) SD )
    select trim(SFUSER)||'/'||trim(OUTQ)||'/'||trim(SFILE)||'~'||trim(regexp_replace(QJOB,'(\\w*)/(\\w*)/(\\w*)','$3~$2~$1'))||'~'||trim(SFNUMBER)||'.splf'||':'||char(ORDINAL_POSITION)||':'||varchar(trim(SPOOL_DATA),132) SEARCH_RESULT
      from ALL_USER_SPOOLED_FILE_DATA AMD
      where upper(SPOOL_DATA) like upper('%${sanitizeSearchTerm(searchTerm)}%');`
          ;
        const rs = await Code4i!.runSQL(sqlStatement);
        var resultString = rs.map(function (rsElem) { return rsElem.SEARCH_RESULT; }).join("\n");
        var result = {
          code: 0,
          stdout: `${resultString}`,
          stderr: ``,
          command: ``
        } as CommandResult;
        if (!result.stderr) {
          // path: "/${user}/QEZJOBLOG/QPJOBLOG~D000D2034A~[USERPROFILE]~849412~1.splf" <- path should be like this
          // NOTE: Path issue with part names with underscores in them.  Need a different job separator token or can we use more sub parts to the path??
          return parseGrepOutput(result.stdout || '', filter,
            path => connection.sysNameInLocal(path)); // TODO: add the scheme context of spooledfile_readonly: to path
        }
        else {
          throw new Error(result.stderr);
        }
      }
      else {return [];}
    }
    else {
      throw new Error("Please connect to an IBM i");
    }
  }
}

function sliceUp(arr: any[], size: number): any[] {
  const result = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}
function sanitizeSearchTerm(searchTerm: string): string {
  return searchTerm.replace(/\\/g, `\\\\`).replace(/"/g, `\\\\"`);
}
function parseGrepOutput(output: string, filter?: string, pathTransformer?: (path: string) => string): MessageQueueSearch.Result[] {
  const results: MessageQueueSearch.Result[] = [];
  const readonly = isProtectedFilter(filter);
  for (const line of output.split('\n')) {
    if (!line.startsWith(`Binary`)) {
      const parts = line.split(`:`); //path:line
      const path = pathTransformer?.(parts[0]) || parts[0];
      let result = results.find(r => r.path === path);
      if (!result) {
        result = {
          path,
          lines: [],
          readonly,
        };
        results.push(result);
      }

      const contentIndex = nthIndex(line, `:`, 2);
      if (contentIndex >= 0) {
        const curContent = line.substring(contentIndex + 1);

        result.lines.push({
          number: Number(parts[1]),
          content: curContent
        });
      }
    }
  }

  return results;
}
function nthIndex(aString: string, pattern: string, n: number) {
  let index = -1;
  while (n-- && index++ < aString.length) {
    index = aString.indexOf(pattern, index);
    if (index < 0) {break;}
  }
  return index;
}