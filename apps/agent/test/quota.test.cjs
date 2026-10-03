const {test}=require('node:test');
const assert=require('node:assert/strict');
const {quotaMountpoint}=require('../dist/quota');

test('quota mountpoint accepts only a managed Docker volume data directory',()=>{
  const id='123e4567-e89b-12d3-a456-426614174000',volume='lab-'+id;
  assert.equal(quotaMountpoint('/srv/lab-docker/volumes',volume,'/srv/lab-docker/volumes/'+volume+'/_data'),'/srv/lab-docker/volumes/'+volume+'/_data');
  assert.throws(()=>quotaMountpoint('/srv/lab-docker/volumes',volume,'/tmp/'+volume+'/_data'));
  assert.throws(()=>quotaMountpoint('/srv/lab-docker/volumes','other','/srv/lab-docker/volumes/other/_data'));
});
