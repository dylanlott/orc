FROM debian:sid
LABEL maintainer "gordonh@member.fsf.org"
RUN apt-get update
RUN apt-get -y upgrade
RUN apt-get -y install wget apt-transport-https gnupg
RUN wget -qO - https://apt.z.cash/zcash.asc | apt-key add -
RUN wget -qO - https://deb.nodesource.com/setup_6.x | bash -
RUN echo "deb [arch=amd64] https://apt.z.cash/ jessie main" | tee /etc/apt/sources.list.d/zcash.list
RUN apt-get update; \
    apt-get -y install vim libssl-dev git python build-essential tor zcash nodejs
RUN zcash-fetch-params
RUN git clone https://github.com/orcproject/orc ~/orc; \
    cd ~/orc && npm install && npm link && cd
RUN mkdir ~/.zcash; \
    echo "rpcuser=orc" >> ~/.zcash/zcash.conf; \
    echo "rpcpassword=orc" >> ~/.zcash/zcash.conf; \
    echo "proxy=127.0.0.1:9050" >> ~/.zcash/zcash.conf; \
    echo "mainnet=1" >> ~/.zcash/zcash.conf; \
    echo "addnode=mainnet.z.cash" >> ~/.zcash/zcash.conf
RUN echo "#\!/bin/bash" >> ~/orc.sh; \
    echo "tor --runasdaemon 1" >> ~/orc.sh; \
    echo "zcashd -daemon" >> ~/orc.sh; \
    echo "orc" >> ~/orc.sh
RUN chmod +x ~/orc.sh
RUN mkdir -p ~/.config/orc
VOLUME ["/root/.config/orc"]
CMD ~/orc.sh
ENTRYPOINT []
